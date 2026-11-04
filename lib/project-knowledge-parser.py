"""Bounded offline parser, launched only for files in a UI-selected project root."""
import io
import json
import re
import sys
import os
import zipfile
import xml.etree.ElementTree as ET
from pathlib import PurePosixPath

MAX_INPUT = 2 * 1024 * 1024
MAX_EXPANDED = 12 * 1024 * 1024
MAX_TEXT = 2 * 1024 * 1024
MAX_ITEMS = 50000
MAX_ITEM_TEXT = 512 * 1024
MAX_JSON_BYTES = 10 * 1024 * 1024
MAX_SHEETS = 256
PROCESS_MEMORY_BYTES = 256 * 1024 * 1024
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
S = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
P = '{http://schemas.openxmlformats.org/package/2006/relationships}'


def apply_memory_limit():
    """Fail closed when an OS-enforced limit cannot be established."""
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes

        class Basic(ctypes.Structure):
            _fields_ = [('PerProcessUserTimeLimit', ctypes.c_longlong), ('PerJobUserTimeLimit', ctypes.c_longlong),
                        ('LimitFlags', wintypes.DWORD), ('MinimumWorkingSetSize', ctypes.c_size_t),
                        ('MaximumWorkingSetSize', ctypes.c_size_t), ('ActiveProcessLimit', wintypes.DWORD),
                        ('Affinity', ctypes.c_size_t), ('PriorityClass', wintypes.DWORD), ('SchedulingClass', wintypes.DWORD)]

        class Io(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in ('ReadOperationCount', 'WriteOperationCount',
                        'OtherOperationCount', 'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount')]

        class Extended(ctypes.Structure):
            _fields_ = [('BasicLimitInformation', Basic), ('IoInfo', Io), ('ProcessMemoryLimit', ctypes.c_size_t),
                        ('JobMemoryLimit', ctypes.c_size_t), ('PeakProcessMemoryUsed', ctypes.c_size_t),
                        ('PeakJobMemoryUsed', ctypes.c_size_t)]

        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel.CreateJobObjectW.restype = wintypes.HANDLE
        kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        kernel.SetInformationJobObject.restype = wintypes.BOOL
        kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.CreateJobObjectW(None, None)
        if not handle:
            raise ValueError('PARSER_MEMORY_LIMIT_UNAVAILABLE')
        info = Extended()
        info.BasicLimitInformation.LimitFlags = 0x100  # JOB_OBJECT_LIMIT_PROCESS_MEMORY
        info.ProcessMemoryLimit = PROCESS_MEMORY_BYTES
        if not kernel.SetInformationJobObject(handle, 9, ctypes.byref(info), ctypes.sizeof(info)) or not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess()):
            kernel.CloseHandle(handle)
            raise ValueError('PARSER_MEMORY_LIMIT_UNAVAILABLE')
        # Keep the exact job handle alive for the lifetime of this process.
        globals()['_memory_job_handle'] = handle
    elif os.name == 'posix':
        try:
            import resource
            _, hard = resource.getrlimit(resource.RLIMIT_AS)
            limit = PROCESS_MEMORY_BYTES if hard == resource.RLIM_INFINITY else min(PROCESS_MEMORY_BYTES, hard)
            resource.setrlimit(resource.RLIMIT_AS, (limit, hard))
            if resource.getrlimit(resource.RLIMIT_AS)[0] > PROCESS_MEMORY_BYTES:
                raise ValueError()
        except Exception:
            raise ValueError('PARSER_MEMORY_LIMIT_UNAVAILABLE')
    else:
        raise ValueError('PARSER_MEMORY_LIMIT_UNAVAILABLE')


class SegmentBudget:
    def __init__(self):
        self.count = 0
        self.text = 0
        self.encoded = 1024

    def add(self, text, location_extra=0):
        # With ensure_ascii=True, each Unicode scalar uses at most 12 ASCII
        # bytes (surrogate pair), plus bounded JSON keys and location fields.
        if len(text) > MAX_ITEM_TEXT:
            raise ValueError('DOCUMENT_ITEM_TEXT_LIMIT')
        self.count += 1
        self.text += len(text)
        self.encoded += len(text) * 12 + location_extra * 12 + 256
        if self.count > MAX_ITEMS:
            raise ValueError('DOCUMENT_ITEM_LIMIT')
        if self.text > MAX_TEXT or self.encoded > MAX_JSON_BYTES:
            raise ValueError('EXTRACTED_TEXT_LIMIT')


def bounded_join(nodes):
    parts, length = [], 0
    for node in nodes:
        value = node.text or ''
        length += len(value)
        if length > MAX_ITEM_TEXT:
            raise ValueError('DOCUMENT_ITEM_TEXT_LIMIT')
        parts.append(value)
    return ''.join(parts)


def archive(data):
    z = zipfile.ZipFile(io.BytesIO(data))
    info = z.infolist()
    if len(info) > 1000 or sum(i.file_size for i in info) > MAX_EXPANDED:
        raise ValueError('ARCHIVE_EXPANSION_LIMIT')
    names = [i.filename for i in info]
    if len(names) != len(set(names)) or any(i.flag_bits & 1 for i in info):
        raise ValueError('INVALID_OR_ENCRYPTED_ARCHIVE')
    return z


def xml(z, name, optional=False):
    try:
        raw = z.read(name)
    except KeyError:
        if optional:
            return None
        raise ValueError('MISSING_DOCUMENT_PART')
    if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
        raise ValueError('XML_DTD_UNSUPPORTED')
    return ET.fromstring(raw)


def word(data):
    z = archive(data)
    document = xml(z, 'word/document.xml')
    segments, budget = [], SegmentBudget()
    for index, paragraph in enumerate(document.iter(W + 'p'), 1):
        text = bounded_join(paragraph.iter(W + 't'))
        if text:
            budget.add(text)
            segments.append({'text': text, 'location': {'paragraph': index}})
    return {'segments': segments, 'warnings': ['WORD_BODY_PARAGRAPHS_ONLY']}


def excel(data):
    z = archive(data)
    workbook = xml(z, 'xl/workbook.xml')
    rels = xml(z, 'xl/_rels/workbook.xml.rels')
    targets = {r.get('Id'): r.get('Target') for r in rels.findall(P + 'Relationship') if r.get('TargetMode') != 'External'}
    shared_xml = xml(z, 'xl/sharedStrings.xml', True)
    shared, shared_chars = [], 0
    if shared_xml is not None:
        for item in shared_xml.iter(S + 'si'):
            value = bounded_join(item.iter(S + 't'))
            shared_chars += len(value)
            if len(shared) >= MAX_ITEMS or shared_chars > MAX_TEXT:
                raise ValueError('SHARED_STRING_LIMIT')
            shared.append(value)
    segments, sheets, warnings, budget = [], [], [], SegmentBudget()
    for sheet in workbook.findall('.//' + S + 'sheet'):
        name, target = sheet.get('name'), targets.get(sheet.get(R + 'id'))
        if not name or not target:
            raise ValueError('MISSING_SHEET_RELATION')
        if len(sheets) >= MAX_SHEETS or len(name) > 256:
            raise ValueError('SHEET_LIMIT')
        part = str(PurePosixPath('xl') / target) if not target.startswith('/') else target.lstrip('/')
        if '..' in PurePosixPath(part).parts or not part.startswith('xl/'):
            raise ValueError('INVALID_SHEET_RELATION')
        tree = xml(z, part)
        sheets.append(name)
        for cell in tree.iter(S + 'c'):
            ref, kind = cell.get('r', ''), cell.get('t', 'n')
            match = re.fullmatch(r'([A-Z]{1,3})([1-9][0-9]{0,6})', ref)
            if not match:
                raise ValueError('INVALID_CELL_REFERENCE')
            column = 0
            for letter in match.group(1):
                column = column * 26 + ord(letter) - 64
            if column > 16384 or int(match.group(2)) > 1048576:
                raise ValueError('INVALID_CELL_REFERENCE')
            formula = cell.find(S + 'f') is not None
            value_node = cell.find(S + 'v')
            raw = '' if value_node is None else (value_node.text or '')
            if kind == 's':
                if not raw.isdigit() or int(raw) >= len(shared):
                    raise ValueError('INVALID_SHARED_STRING')
                value = shared[int(raw)]
            elif kind == 'inlineStr':
                value = bounded_join(cell.iter(S + 't'))
            elif kind in ('n', 'str', 'b', 'e'):
                value = raw
            else:
                raise ValueError('UNSUPPORTED_CELL_TYPE')
            if value or formula:
                budget.add(value, len(name))
                segments.append({'text': value, 'location': {'sheet': name, 'cell': ref}, 'cellType': kind, 'formula': formula})
            if formula and 'FORMULA_CACHE_NOT_RECALCULATED' not in warnings:
                warnings.append('FORMULA_CACHE_NOT_RECALCULATED')
    return {'segments': segments, 'sheets': sheets, 'warnings': warnings}


def pdf(data):
    try:
        from pypdf import PdfReader
    except ImportError:
        raise ValueError('PDF_PARSER_UNAVAILABLE')
    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted:
        raise ValueError('PDF_ENCRYPTED')
    if len(reader.pages) > 200:
        raise ValueError('PDF_PAGE_LIMIT')
    segments, budget = [], SegmentBudget()
    for page_index, page in enumerate(reader.pages, 1):
        for line_index, text in enumerate((page.extract_text() or '').splitlines(), 1):
            if text:
                budget.add(text)
                segments.append({'text': text, 'location': {'page': page_index, 'line': line_index}})
    return {'segments': segments, 'warnings': ['PDF_TEXT_EXTRACTION_ONLY'] + ([] if segments else ['PDF_NO_EXTRACTABLE_TEXT'])}


def main():
    apply_memory_limit()
    data = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(data) > MAX_INPUT:
        raise ValueError('INPUT_BYTE_LIMIT')
    kind = sys.argv[1]
    result = {'docx': word, 'xlsx': excel, 'pdf': pdf}[kind](data)
    if sum(len(segment['text']) for segment in result['segments']) > MAX_TEXT:
        raise ValueError('EXTRACTED_TEXT_LIMIT')
    print(json.dumps({'ok': True, 'value': result}, ensure_ascii=True))


try:
    main()
except Exception as error:
    code = str(error) if re.fullmatch(r'[A-Z_]{3,80}', str(error)) else 'DOCUMENT_PARSE_FAILED'
    print(json.dumps({'ok': False, 'error': {'code': code}}))
