"""File formats the product hands back to a reviewer.

Kept apart from ``backend/engine`` on purpose: the engine adapter owns *what a value is* (which string
gets embedded, which rows the loader kept), and this package owns *how it is written down*. The Excel
sheet-name cap and the cell-character limit are properties of a file format, not of harmonization, and
mixing the two would put spreadsheet trivia in the module that has to stay readable when the pipeline
churns.
"""
