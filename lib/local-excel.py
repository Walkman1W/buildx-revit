"""Build and verify a local XLSX using openpyxl in an isolated worker."""

from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import re
import sys
from tempfile import TemporaryDirectory
from xml.etree import ElementTree
from zipfile import ZipFile


FILE_PART = re.compile(
    r"(?:\[Content_Types\]\.xml|_rels/\.rels|docProps/(?:app|core)\.xml|"
    r"xl/(?:workbook\.xml|_rels/workbook\.xml\.rels|styles\.xml|sharedStrings\.xml|"
    r"theme/theme[1-9][0-9]*\.xml|worksheets/sheet[1-9][0-9]*\.xml))"
)
CELL_REFERENCE = re.compile(r"\$?([A-Z]{1,2})\$?([1-9][0-9]{0,3})")
XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
MAX_TEMPLATE_BYTES = 8 * 1024 * 1024
MAX_UNPACKED_BYTES = 24 * 1024 * 1024


class TaskError(Exception):
    def __init__(self, code):
        self.code = code


def unsupported():
    return TaskError("EXCEL_TEMPLATE_UNSUPPORTED")


def validate_template_package(data):
    with ZipFile(BytesIO(data)) as archive:
        infos = archive.infolist()
        names = [info.filename for info in infos]
        if (len(names) > 40 or len(set(names)) != len(names)
                or any(not FILE_PART.fullmatch(name) for name in names)
                or sum(info.file_size for info in infos) > MAX_UNPACKED_BYTES
                or not {"[Content_Types].xml", "_rels/.rels", "xl/workbook.xml",
                        "xl/_rels/workbook.xml.rels"}.issubset(names)):
            raise unsupported()
        for name in names:
            xml = archive.read(name).decode("utf-8-sig")
            if "\x00" in xml or re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", xml, re.I):
                raise unsupported()
            if name.endswith(".rels"):
                for entry in ElementTree.fromstring(xml):
                    mode = entry.get("TargetMode", "Internal")
                    target = entry.get("Target", "")
                    if mode != "Internal" or not target or ":" in target or "\\" in target:
                        raise unsupported()
                    if any(part == ".." for part in target.split("/")):
                        raise unsupported()
            if name == "[Content_Types].xml":
                types = {entry.get("PartName"): entry.get("ContentType") for entry in ElementTree.fromstring(xml)}
                if types.get("/xl/workbook.xml") != XLSX_CONTENT_TYPE:
                    raise unsupported()


def valid_template_formula(value, patterns, limits):
    if not isinstance(value, str) or len(value) > 240:
        return False
    expression = value.replace(" ", "").replace("\t", "").upper()
    if not any(pattern.fullmatch(expression) for pattern in patterns):
        return False
    for letters, row in CELL_REFERENCE.findall(expression):
        column = 0
        for letter in letters:
            column = column * 26 + ord(letter) - 64
        if column > limits["columns"] or int(row) > limits["rows"]:
            return False
    return True


def load_template(source, load_workbook, formula_patterns, limits):
    try:
        if source.is_symlink() or not source.is_file():
            raise unsupported()
        with source.open("rb") as stream:
            data = stream.read(MAX_TEMPLATE_BYTES + 1)
        if not data or len(data) > MAX_TEMPLATE_BYTES:
            raise unsupported()
        validate_template_package(data)
        book = load_workbook(BytesIO(data), keep_links=False)
        try:
            if book.template or book.defined_names or len(book.worksheets) > limits["sheets"]:
                raise unsupported()
            total = 0
            for sheet in book.worksheets:
                total += sheet.max_row * sheet.max_column
                if (sheet.max_row > limits["rows"] or sheet.max_column > limits["columns"]
                        or total > limits["cells"] or sheet.merged_cells or sheet.defined_names
                        or len(sheet.conditional_formatting) or len(sheet.data_validations.dataValidation)):
                    raise unsupported()
                for row in sheet.iter_rows():
                    for cell in row:
                        if cell.data_type == "f" and not valid_template_formula(cell.value, formula_patterns, limits):
                            raise unsupported()
        except Exception:
            book.close()
            raise
        return book
    except Exception as error:
        raise unsupported() from error


def value_of(cell):
    if not isinstance(cell, dict):
        return cell, False, None
    is_formula = "formula" in cell
    return cell["formula" if is_formula else "value"], is_formula, cell.get("numberFormat")


def populate(book, sheets, Font, limits, template):
    initial = set(book.sheetnames)
    casefolded = {name.casefold() for name in initial}
    if template and len(initial.union(sheet["name"] for sheet in sheets)) > limits["sheets"]:
        raise unsupported()
    for spec in sheets:
        name = spec["name"]
        if name not in initial and name.casefold() in casefolded:
            raise unsupported()
        casefolded.add(name.casefold())
        sheet = book[name] if name in initial else book.create_sheet(name)
        if len(sheets) == 1:
            book.active = book.index(sheet)
        for row_index, row in enumerate(spec["rows"], 1):
            for column, content in enumerate(row, 1):
                cell = sheet.cell(row_index, column)
                value, is_formula, number_format = value_of(content)
                cell.value = value
                if isinstance(value, str) and not is_formula:
                    cell.data_type = "s"
                if number_format is not None:
                    cell.number_format = number_format
                if row_index == 1 and spec.get("header"):
                    cell.font = Font(bold=True)
        if spec.get("header"):
            sheet.freeze_panes = "A2"


def verify_workbook(file, sheets, expected_names, load_workbook):
    book = load_workbook(file, data_only=False, keep_links=False)
    cells = 0
    formulas = 0
    try:
        if book.sheetnames != expected_names:
            raise TaskError("EXCEL_VALIDATION_FAILED")
        for spec in sheets:
            sheet = book[spec["name"]]
            if spec.get("header") and sheet.freeze_panes != "A2":
                raise TaskError("EXCEL_VALIDATION_FAILED")
            for row_index, row in enumerate(spec["rows"], 1):
                for column, content in enumerate(row, 1):
                    cell = sheet.cell(row_index, column)
                    value, is_formula, number_format = value_of(content)
                    cells += 1
                    formulas += is_formula
                    data_type = ("f" if is_formula else "s" if isinstance(value, str)
                                 else "b" if isinstance(value, bool) else "n")
                    if (cell.value != value or cell.data_type != data_type
                            or (number_format is not None and cell.number_format != number_format)
                            or (row_index == 1 and spec.get("header") and not cell.font.bold)):
                        raise TaskError("EXCEL_VALIDATION_FAILED")
        return cells, formulas
    finally:
        book.close()


def execute(payload):
    try:
        if payload.get("dependencyPath"):
            sys.path.append(payload["dependencyPath"])
        from openpyxl import Workbook, load_workbook
        from openpyxl.styles import Font
    except ImportError as error:
        raise TaskError("EXCEL_DEPENDENCY_UNAVAILABLE") from error

    output = Path(payload["outputPath"])
    if os.path.lexists(output):
        raise TaskError("EXCEL_OUTPUT_EXISTS")
    template = payload.get("templatePath")
    limits = payload["limits"]
    if template:
        patterns = [re.compile(pattern) for pattern in payload["formulaPatterns"]]
        book = load_template(Path(template), load_workbook, patterns, limits)
    else:
        book = Workbook()
        book.remove(book.active)
    sheets = payload["workbook"]["sheets"]
    try:
        populate(book, sheets, Font, limits, template)
        with TemporaryDirectory(dir=output.parent, prefix=".buildx-excel-") as pending:
            file = Path(pending) / "workbook.xlsx"
            book.save(file)
            try:
                cells, formulas = verify_workbook(file, sheets, book.sheetnames, load_workbook)
            except Exception as error:
                raise TaskError("EXCEL_VALIDATION_FAILED") from error
            data = file.read_bytes()
            try:
                os.link(file, output)
            except FileExistsError as error:
                raise TaskError("EXCEL_OUTPUT_EXISTS") from error
        return {"ok": True, "formulaCount": formulas, "cellCount": cells, "bytes": len(data),
                "sha256": sha256(data).hexdigest(), "formulasCalculated": False,
                "templateCopied": bool(template)}
    finally:
        book.close()


def main():
    raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 32769)
    try:
        if len(raw) > 2 * 1024 * 1024 + 32768:
            raise TaskError("EXCEL_WRITE_FAILED")
        result = execute(json.loads(raw.decode("utf-8")))
        print(json.dumps(result))
        return 0
    except TaskError as error:
        print(json.dumps({"ok": False, "code": error.code}))
    except Exception:
        print(json.dumps({"ok": False, "code": "EXCEL_WRITE_FAILED"}))
    return 1


if __name__ == "__main__":
    sys.exit(main())
