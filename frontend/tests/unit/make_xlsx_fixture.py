"""Builds frontend/tests/unit/fixtures/import-sample.xlsx without any dependencies.

The file is a real .xlsx package (OPC): a ZIP written by Python's zipfile with deflate compression,
containing the parts a real Excel file has ([Content_Types].xml, _rels/.rels, workbook, relationships,
shared strings with one rich-text run, and a worksheet in the style Excel writes, with r/span attributes,
a skipped column, style references, an inline-string cell, a boolean cell, and a decimal number).
Used by import.test.ts (and available for browser testing) so the zip.js/xlsx.js readers are exercised
by a standard ZIP writer, not only by code that thinks like them.

Run once from the repository root:  python frontend/tests/unit/make_xlsx_fixture.py
"""
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fixtures", "import-sample.xlsx")

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>"""

RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>"""

CORE = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:creator>English Test import fixture</dc:creator>
</cp:coreProperties>"""

WORKBOOK = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Questions" sheetId="1" r:id="rId1"/></sheets>
</workbook>"""

WORKBOOK_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"""

STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs>
<cellXfs count="1"><xf xfId="0"/></cellXfs>
</styleSheet>"""

# Shared strings, in the order the sheet refers to them. The last one is rich text (two runs), which must read as plain text.
SHARED = [
    "question", "option_a", "option_b", "option_c", "option_d", "correct", "topic", "difficulty", "points", "class", "reading_text",
    "What did Dina do first after she found the wallet?",
    "She kept the money.", "She looked around for the owner.", "She called the police.", "She left it under the bench.",
    "B", "Narrative Text", "HOTS", "XII TKJ A", "The Lost Wallet",
    "Dina found a key.", "True",
    "The story was told in the ____ tense.", "past | simple past", "Easy",
    "Points come as a number here.",
]

SHARED_STRINGS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="27" uniqueCount="27">
""" + "\n".join(
    "<si><r><rPr><b/></rPr><t>Points come </t></r><r><t>as a number here.</t></r></si>" if s == "Points come as a number here."
    else f"<si><t xml:space=\"preserve\">{s}</t></si>"
    for s in SHARED
) + "\n</sst>"


def cell(ref, kind, value, style=""):
    s = f' s="{style}"' if style else ""
    if kind == "s":
        return f'<c r="{ref}" t="s"{s}><v>{value}</v></c>'
    if kind == "n":
        return f'<c r="{ref}"{s}><v>{value}</v></c>'
    if kind == "b":
        return f'<c r="{ref}" t="b"{s}><v>{value}</v></c>'
    if kind == "inline":
        return f'<c r="{ref}" t="inlineStr"{s}><is><t>{value}</t></is></c>'
    return ""


# Row 1: header. Row 2: multiple choice (column I "points" skipped). Row 3: true/false with a whole number.
# Row 4: short answer with a decimal number and an inline-string class. Row 5: rich-text question and a boolean in points.
SHEET = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac">\n'
    "<sheetData>\n"
    '<row r="1" spans="1:11" x14ac:dyDescent="0.2">' + "".join(cell(f"{ch}1", "s", i, "1") for i, ch in enumerate("ABCDEFGHIJK")) + "</row>\n"
    '<row r="2" spans="1:11" x14ac:dyDescent="0.2">'
    + cell("A2", "s", 11) + cell("B2", "s", 12) + cell("C2", "s", 13) + cell("D2", "s", 14) + cell("E2", "s", 15)
    + cell("F2", "s", 16) + cell("G2", "s", 17) + cell("H2", "s", 18) + cell("J2", "s", 19) + cell("K2", "s", 20)
    + "</row>\n"
    '<row r="3" spans="1:11" x14ac:dyDescent="0.2">'
    + cell("A3", "s", 21) + cell("F3", "s", 22) + cell("G3", "s", 17) + cell("H3", "s", 18) + cell("I3", "n", "1") + cell("J3", "s", 19)
    + "</row>\n"
    '<row r="4" spans="1:11" x14ac:dyDescent="0.2">'
    + cell("A4", "s", 23) + cell("F4", "s", 24) + cell("G4", "s", 17) + cell("H4", "s", 25) + cell("I4", "n", "1.5") + cell("J4", "inline", "XI TKJ 2")
    + "</row>\n"
    '<row r="5" spans="1:11" x14ac:dyDescent="0.2">' + cell("A5", "s", 26) + cell("I5", "b", "1") + "</row>\n"
    "</sheetData>\n"
    "</worksheet>"
)

PARTS = [
    ("[Content_Types].xml", CONTENT_TYPES),
    ("_rels/.rels", RELS),
    ("docProps/core.xml", CORE),
    ("xl/workbook.xml", WORKBOOK),
    ("xl/_rels/workbook.xml.rels", WORKBOOK_RELS),
    ("xl/styles.xml", STYLES),
    ("xl/sharedStrings.xml", SHARED_STRINGS),
    ("xl/worksheets/sheet1.xml", SHEET),
]

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    for name, data in PARTS:
        info = zipfile.ZipInfo(name, date_time=(2026, 9, 22, 9, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o600 << 16
        z.writestr(info, data.encode("utf-8"))
print("wrote", OUT)
