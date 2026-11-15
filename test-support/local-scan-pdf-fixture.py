"""Generate a synthetic bilingual pump quote for the offline OCR test."""

import io
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject


def fixture(font_path, output_path):
    page = Image.new('RGB', (1600, 1050), 'white')
    pen = ImageDraw.Draw(page)
    title = ImageFont.truetype(font_path, 79)
    font = ImageFont.truetype(font_path, 62)
    pen.text((100, 75), '水泵设备报价单', font=title, fill='black')
    pen.text((100, 185), 'PUMP QUOTATION', font=font, fill='black')
    for index, label in enumerate((
        '型号   MODEL: BX-150-80', '数量   QUANTITY: 2',
        '单价   UNIT PRICE: 12500.00 CNY', '合计   TOTAL: 25000.00 CNY',
        '交货   DELIVERY: 30 DAYS',
    )):
        pen.text((100, 315 + 125 * index), label, font=font, fill='black')
    image_only = io.BytesIO()
    page.save(image_only, format='PDF', resolution=150)
    writer = PdfWriter()
    writer.add_page(PdfReader(image_only).pages[0])

    terms = writer.add_blank_page(width=612, height=792)
    helvetica = DictionaryObject({NameObject('/Type'): NameObject('/Font'),
                                  NameObject('/Subtype'): NameObject('/Type1'),
                                  NameObject('/BaseFont'): NameObject('/Helvetica')})
    terms[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): helvetica})})
    stream = DecodedStreamObject()
    stream.set_data(b'BT /F1 24 Tf 60 700 Td (DIGITAL TERMS: PUMP QUOTATION) Tj ET')
    terms[NameObject('/Contents')] = stream
    with Path(output_path).open('xb') as target:
        writer.write(target)


if __name__ == '__main__':
    fixture(sys.argv[1], sys.argv[2])
