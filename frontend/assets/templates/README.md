# Import templates

Sample files for the question import screen (`#/questions/import`): one Excel workbook and one CSV file with the recognized column names and three example rows. Teachers can download them from the import screen and fill in their own questions.

Both files are built by `make_import_template.py` in this folder (no dependencies); the outputs are committed. To change the templates, edit the script and run from the repository root:

```
python frontend/assets/templates/make_import_template.py
```
