"""Bounded, offline text extraction and rasterization for selected PDF pages."""

import io
import json
import math
import os
import site
import sys
from contextlib import closing
from pathlib import Path

MAX_INPUT = 20 * 1024 * 1024
MAX_PAGES = 8
MAX_DOCUMENT_PAGES = 2000
MAX_TEXT = 4000
MAX_PIXELS = 5_000_000
PROCESS_MEMORY_BYTES = 384 * 1024 * 1024


def limit_memory():
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
            raise ValueError('SCAN_PDF_MEMORY_LIMIT_UNAVAILABLE')
        info = Extended()
        info.BasicLimitInformation.LimitFlags = 0x100
        info.ProcessMemoryLimit = PROCESS_MEMORY_BYTES
        if not (kernel.SetInformationJobObject(handle, 9, ctypes.byref(info), ctypes.sizeof(info))
                and kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess())):
            kernel.CloseHandle(handle)
            raise ValueError('SCAN_PDF_MEMORY_LIMIT_UNAVAILABLE')
        globals()['_memory_job_handle'] = handle
    elif os.name == 'posix':
        import resource
        _, hard = resource.getrlimit(resource.RLIMIT_AS)
        limit = PROCESS_MEMORY_BYTES if hard == resource.RLIM_INFINITY else min(PROCESS_MEMORY_BYTES, hard)
        resource.setrlimit(resource.RLIMIT_AS, (limit, hard))
    else:
        raise ValueError('SCAN_PDF_MEMORY_LIMIT_UNAVAILABLE')


def page_text(page):
    try:
        text = (page.extract_text() or '').strip()
    except MemoryError:
        raise
    except Exception:
        return '', False, False
    sufficient = sum(character.isalnum() for character in text[:MAX_TEXT]) >= 16
    return text[:MAX_TEXT], len(text) > MAX_TEXT, sufficient


def rasterize(pdf, page_number, target):
    with closing(pdf[page_number - 1]) as page:
        width, height = page.get_size()
        if not all(math.isfinite(size) and size > 0 for size in (width, height)):
            raise ValueError('SCAN_PDF_BAD_PAGE_SIZE')
        scale = min(250 / 72, 3200 / max(width, height), math.sqrt((MAX_PIXELS - 8000) / width / height))
        if math.ceil(width * scale) * math.ceil(height * scale) > MAX_PIXELS:
            raise ValueError('SCAN_PDF_BAD_PAGE_SIZE')
        with closing(page.render(scale=scale, grayscale=True, may_draw_forms=False)) as bitmap:
            dpi = scale * 72
            bitmap.to_pil().save(target, format='PNG', dpi=(dpi, dpi))
            return [bitmap.width, bitmap.height]


def render_pending(data, directory, pending):
    if not pending:
        return
    try:
        import pypdfium2 as pdfium
        from PIL import Image  # Verify the conversion dependency before rendering.
    except ImportError:
        for item in pending:
            item['issue'] = 'SCAN_PDF_RENDERER_UNAVAILABLE'
        return
    try:
        with closing(pdfium.PdfDocument(data)) as document:
            for item in pending:
                try:
                    image_path = directory / ('page-%d.png' % item['page'])
                    item['imageSize'] = rasterize(document, item['page'], image_path)
                except MemoryError:
                    raise
                except Exception:
                    item['issue'] = 'SCAN_PDF_RENDER_FAILED'
    except MemoryError:
        raise
    except Exception:
        for item in pending:
            item['issue'] = 'SCAN_PDF_RENDER_FAILED'


def scan(data, directory, selected, mode):
    try:
        from pypdf import PdfReader
    except ImportError:
        raise ValueError('SCAN_PDF_READER_UNAVAILABLE') from None

    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted:
        raise ValueError('SCAN_PDF_ENCRYPTED')
    total = len(reader.pages)
    if not 0 < total <= MAX_DOCUMENT_PAGES:
        raise ValueError('SCAN_PDF_DOCUMENT_PAGE_LIMIT')
    if selected is None:
        if total > MAX_PAGES:
            raise ValueError('SCAN_PDF_PAGE_SELECTION_REQUIRED')
        selected = range(1, total + 1)
    if any(page > total for page in selected):
        raise ValueError('SCAN_PDF_PAGE_OUT_OF_RANGE')

    pages = []
    for page_number in selected:
        text, truncated, sufficient = page_text(reader.pages[page_number - 1])
        pages.append({'page': page_number, 'text': text, 'truncated': truncated,
                      'source': 'text' if sufficient and mode == 'auto' else 'pending'})
    render_pending(data, directory, [page for page in pages if page['source'] == 'pending'])
    return {'pageCount': total, 'pages': pages}


try:
    limit_memory()
    # Python's isolated mode excludes user-site startup code. Permit imports
    # from the selected installed runtime's usual user package directory.
    user_packages = site.getusersitepackages()
    if isinstance(user_packages, str) and Path(user_packages).is_absolute():
        sys.path.append(user_packages)
    data = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(data) > MAX_INPUT:
        raise ValueError('SCAN_PDF_INPUT_LIMIT')
    options = json.loads(sys.argv[2])
    result = {'ok': True, 'value': scan(data, Path(sys.argv[1]), options['pages'], options['mode'])}
except MemoryError:
    result = {'ok': False, 'code': 'SCAN_PDF_MEMORY_LIMIT'}
except Exception as error:
    code = str(error)
    result = {'ok': False, 'code': code if code.startswith('SCAN_PDF_') and code.isascii() else 'SCAN_PDF_PARSE_FAILED'}
print(json.dumps(result, ensure_ascii=True))
