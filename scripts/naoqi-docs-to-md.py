"""Convierte una página de la documentación de NAOqi 2.8 (HTML de Sphinx, doc.aldebaran.com/2-8) a Markdown simple.

Uso: python3 -I scripts/naoqi-docs-to-md.py <pagina.html> <url-de-origen> > salida.md

Solo con la biblioteca estándar. Toma el contenido desde la primera sección hasta la barra lateral y conserva títulos,
párrafos, listas, tablas, firmas de métodos y bloques de código; los textos no se cambian.
"""

import sys
from html.parser import HTMLParser

BLOCKS = {"p", "dt", "dd", "div", "tr", "li", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "table", "dl", "ul", "ol"}


class Converter(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.inside = False  # entre la primera sección y la barra lateral
        self.done = False
        self.skip = 0  # dentro de un enlace "¶"
        self.pre = 0
        self.out = []
        self.line = []
        self.cells = None  # celdas de la fila de tabla en curso

    def flush(self, prefix=""):
        text = "".join(self.line)
        self.line = []
        if self.pre:
            return
        text = " ".join(text.split())
        if text:
            self.out.append(prefix + text)
            self.out.append("")

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = a.get("class") or ""
        if self.done:
            return
        if not self.inside:
            if tag == "div" and "section" in cls.split():
                self.inside = True
            else:
                return
        if tag == "div" and "sphinxsidebar" in cls:
            self.flush()
            self.done = True
            return
        if tag == "a" and "headerlink" in cls:
            self.skip += 1
        elif tag == "pre":
            self.flush()
            self.pre += 1
            self.out.append("```")
        elif tag == "br":
            self.line.append("\n" if self.pre else " ")
        elif tag == "tr":
            self.flush()
            self.cells = []
        elif tag in ("td", "th") and self.cells is not None:
            self.line = []
        elif tag in BLOCKS and self.cells is None:
            self.flush()

    def handle_endtag(self, tag):
        if not self.inside or self.done:
            return
        if tag == "a" and self.skip:
            self.skip -= 1
        elif tag == "pre" and self.pre:
            self.out.append("".join(self.line).rstrip("\n"))
            self.out.append("```")
            self.out.append("")
            self.line = []
            self.pre -= 1
        elif tag in ("td", "th") and self.cells is not None:
            self.cells.append(" ".join("".join(self.line).split()))
            self.line = []
        elif tag == "tr" and self.cells is not None:
            if any(self.cells):
                self.out.append("| " + " | ".join(self.cells) + " |")
                self.out.append("")
            self.cells = None
        elif self.cells is not None:
            return  # dentro de una celda: el texto sigue en la celda
        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self.flush("#" * int(tag[1]) + " ")
        elif tag == "li":
            self.flush("- ")
        elif tag in BLOCKS:
            self.flush()

    def handle_data(self, data):
        if self.inside and not self.done and not self.skip:
            self.line.append(data)


def main():
    path, url = sys.argv[1], sys.argv[2]
    conv = Converter()
    with open(path, encoding="utf-8") as f:
        conv.feed(f.read())
    conv.flush()
    lines = [f"<!-- source: {url} -->"]
    for line in conv.out:
        if line == "" and lines[-1] == "":
            continue
        lines.append(line)
    sys.stdout.write("\n".join(lines).rstrip() + "\n")


if __name__ == "__main__":
    main()
