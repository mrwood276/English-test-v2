"""Builds the import template files in this folder (run once; the outputs are committed).

- import-template.xlsx: a small Excel workbook with the recognized column names and three example rows.
- import-template.csv: the same as plain CSV with a BOM so Excel opens it with the right characters.

Run from the repository root:  python frontend/assets/templates/make_import_template.py
"""
import csv
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))

HEADERS = ["type", "question", "option_a", "option_b", "option_c", "option_d", "correct", "guide", "explanation",
           "topic", "difficulty", "points", "class", "reading_text", "reading_text_body"]

ROWS = [
    ["multiple_choice", "Choose the correct sentence.", "He go to school.", "He goes to school.", "He going to school.", "", "B", "", "Third person singular takes -s.", "Simple Present", "Easy", "1", "XII TKJ A", "", ""],
    ["true_false", "The sun rises in the east.", "", "", "", "", "True", "", "", "Simple Present", "Easy", "1", "XII TKJ A", "", ""],
    ["short_answer", "She ___ to school yesterday. (go)", "", "", "", "", "went", "", "", "Simple Past", "Medium", "1", "", "", ""],
    ["essay", "Explain why the orientation matters in a narrative text.", "", "", "", "", "", "One mark per idea: characters, place, time.", "", "Narrative Text", "HOTS", "4", "", "The Lost Wallet", "Dina found a brown wallet under the bench in front of the library."],
]

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>"""

RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"""

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
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs>
<cellXfs count="2"><xf xfId="0"/><xf xfId="0" fontId="1" applyFont="1"/></cellXfs>
</styleSheet>"""


def esc(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;"))


def build_parts():
    strings = []
    ref = {}
    for row in [HEADERS] + ROWS:
        for value in row:
            if value and value not in ref:
                ref[value] = len(strings)
                strings.append(value)
    shared = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
              f'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="{len(strings)}" uniqueCount="{len(strings)}">\n'
              + "\n".join(f'<si><t xml:space="preserve">{esc(s)}</t></si>' for s in strings) + "\n</sst>")

    def cell(col, row, value, style=""):
        if not value:
            return ""
        s = f' s="{style}"' if style else ""
        return f'<c r="{col}{row}" t="s"{s}><v>{ref[value]}</v></c>'

    sheet_rows = []
    sheet_rows.append('<row r="1" spans="1:15">' + "".join(cell(chr(65 + i), 1, h, "1") for i, h in enumerate(HEADERS)) + "</row>")
    for r, row in enumerate(ROWS, start=2):
        cells = "".join(cell(chr(65 + i), r, v) for i, v in enumerate(row))
        sheet_rows.append(f'<row r="{r}" spans="1:15">{cells}</row>')
    sheet = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
             '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">\n'
             "<sheetData>\n" + "\n".join(sheet_rows) + "\n</sheetData>\n</worksheet>")
    return [
        ("[Content_Types].xml", CONTENT_TYPES),
        ("_rels/.rels", RELS),
        ("xl/workbook.xml", WORKBOOK),
        ("xl/_rels/workbook.xml.rels", WORKBOOK_RELS),
        ("xl/styles.xml", STYLES),
        ("xl/sharedStrings.xml", shared),
        ("xl/worksheets/sheet1.xml", sheet),
    ]


xlsx = os.path.join(HERE, "import-template.xlsx")
with zipfile.ZipFile(xlsx, "w", zipfile.ZIP_DEFLATED) as z:
    for name, data in build_parts():
        info = zipfile.ZipInfo(name, date_time=(2026, 9, 22, 10, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, data.encode("utf-8"))

csv_path = os.path.join(HERE, "import-template.csv")
with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
    csv.writer(f).writerows([HEADERS] + ROWS)

print("wrote", xlsx)
print("wrote", csv_path)
