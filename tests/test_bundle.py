"""Tests for whichtalk/bundle.py (and the page assembly around it). Run: python3 -I -m unittest discover tests"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from whichtalk import bundle  # noqa: E402
from whichtalk.jslex import tokenize  # noqa: E402
from whichtalk.site import SiteError, fill_placeholders, inline_css  # noqa: E402

FIXTURES = ROOT / 'tests' / 'fixtures' / 'bundle'
NODE = shutil.which('node')


def link(case: str, entry: str = 'main.js'):
    return bundle.link(FIXTURES / case / entry, FIXTURES / case)


def run_node(*args: str) -> str:
    result = subprocess.run([NODE, *args], capture_output=True, text=True, check=False)  # type: ignore[list-item]
    if result.returncode:
        raise AssertionError(result.stderr)
    return result.stdout.strip()


def run_bundled(case: str, epilogue: str = '') -> str:
    script = bundle.production_script(FIXTURES / case / 'main.js', FIXTURES / case, []) + epilogue
    fd, path = tempfile.mkstemp(suffix='.js')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as fh:
            fh.write(script)
        return run_node(path)
    finally:
        os.unlink(path)


class EvaluationOrder(unittest.TestCase):
    def test_depth_first_post_order_in_import_order(self) -> None:
        order, problems = link('order')
        self.assertEqual(problems, [])
        self.assertEqual([m.path.name for m in order], ['log.js', 'c.js', 'a.js', 'd.js', 'b.js', 'main.js'])

    def test_each_module_appears_once(self) -> None:
        order, _ = link('order')
        self.assertEqual(len(order), len({m.path for m in order}))

    @unittest.skipUnless(NODE, 'node is not installed')
    def test_bundle_runs_modules_in_the_order_node_does(self) -> None:
        entry = (FIXTURES / 'order' / 'main.js').as_uri()
        native = run_node('--input-type=module', '-e',
                          f"await import('{entry}'); console.log(globalThis.__order.join(' '))")
        bundled = run_bundled('order', "\nconsole.log(globalThis.__order.join(' '))\n")
        self.assertEqual(native, 'log c a d b main:acacd')
        self.assertEqual(bundled, native)


class ExportStripping(unittest.TestCase):
    def setUp(self) -> None:
        order, problems = link('strip')
        self.assertEqual(problems, [])
        self.lib = next(m for m in order if m.path.name == 'lib.js')
        self.main = next(m for m in order if m.path.name == 'main.js')

    def test_exported_names(self) -> None:
        self.assertEqual(set(self.lib.exports),
                         {'f', 'g', 'x', 'y', 'z', 'K', 'template', 'pattern', 'ratio', 'picked', 'rest', 'first', 'third'})
        self.assertIn('privateHelper', self.lib.declared)
        self.assertNotIn('privateHelper', self.lib.exports)
        for fake in ('commentFake', 'blockFake', 'insideString', 'nested', 'q', 'r', 's'):
            self.assertNotIn(fake, self.lib.declared)

    def test_export_keywords_removed_and_everything_else_kept(self) -> None:
        text = self.lib.stripped()
        self.assertEqual(text.count('\n'), self.lib.source.count('\n'))
        self.assertIn('\nfunction f () {', text)
        self.assertIn('\nasync function g () {', text)
        self.assertIn('\nconst x = 1, y =', text)
        self.assertIn('\nlet z = x + 1', text)
        self.assertIn('\nclass K {', text)
        self.assertIn("// Not code: export const commentFake = 1; import { q } from './nope.js'", text)
        self.assertIn("return 'export const insideString = 1'", text)
        self.assertIn("`import { s } from './nope.js' ${'export let ' + `nested ${1 + 1}`} }`", text)
        self.assertNotRegex(text, r'(?m)^export\b')

    def test_imports_become_blank_lines(self) -> None:
        text = self.main.stripped()
        self.assertTrue(text.startswith('\n\nconsole.log('))
        self.assertNotIn('import', text)

    @unittest.skipUnless(NODE, 'node is not installed')
    def test_bundle_behaves_like_the_modules(self) -> None:
        entry = (FIXTURES / 'strip' / 'main.js').as_uri()
        native = run_node('--input-type=module', '-e', f"await import('{entry}')")
        self.assertEqual(run_bundled('strip'), native)
        self.assertIn('"export class"', native)

    @unittest.skipUnless(NODE, 'node is not installed')
    def test_bundle_passes_the_syntax_check(self) -> None:
        bundle.check_syntax(bundle.production_script(FIXTURES / 'strip' / 'main.js', FIXTURES / 'strip', []))
        with self.assertRaises(bundle.BundleError):
            bundle.check_syntax('const = 1')


class LinkErrors(unittest.TestCase):
    def problems(self, case: str) -> str:
        with self.assertRaises(bundle.BundleError) as caught:
            bundle.bundle_modules(FIXTURES / case / 'main.js', FIXTURES / case)
        return '\n'.join(caught.exception.problems)

    def test_duplicate_top_level_name(self) -> None:
        message = self.problems('duplicate')
        self.assertIn('top-level name `helper` is declared in several modules', message)
        self.assertIn('one.js', message)
        self.assertIn('two.js', message)

    def test_imported_name_not_exported(self) -> None:
        message = self.problems('missing-export')
        self.assertIn('`absent` is not exported by ./lib.js', message)
        self.assertNotIn('present', message)

    def test_missing_file(self) -> None:
        self.assertIn('not-here.js does not exist', self.problems('missing-file'))

    def test_unsupported_forms(self) -> None:
        folder = FIXTURES / 'unsupported'
        cases = sorted(p for p in folder.glob('*.js') if p.name != 'ok.js')
        self.assertEqual(len(cases), 12)
        for case in cases:
            with self.subTest(case=case.name):
                _, problems = bundle.link(case, FIXTURES)
                self.assertTrue(problems, f'{case.name} should be rejected')
                self.assertTrue(all(p.startswith(f'unsupported/{case.name}:') for p in problems), problems)

    def test_supported_module_passes(self) -> None:
        self.assertEqual(bundle.link(FIXTURES / 'unsupported' / 'ok.js', FIXTURES)[1], [])

    def test_import_and_local_declaration_clash(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, 'a.js').write_text('export const a = 1\n')
            Path(tmp, 'main.js').write_text("import { a } from './a.js'\nconst a = 2\n")
            problems = bundle.link(Path(tmp, 'main.js'), Path(tmp))[1]
        self.assertTrue(any('`a` is already declared here' in p for p in problems), problems)


class Tokenizer(unittest.TestCase):
    def kinds(self, src: str):
        return [(t.kind, t.text) for t in tokenize(src)]

    def test_regex_and_division(self) -> None:
        self.assertIn(('regex', '/a[/]b/g'), self.kinds('x = /a[/]b/g'))
        self.assertEqual([k for k, _ in self.kinds('a / b / c')], ['name', 'punct', 'name', 'punct', 'name'])
        self.assertIn(('regex', '/x/'), self.kinds('return /x/.test(s)'))

    def test_template_substitutions_nest(self) -> None:
        toks = self.kinds('`a${ {b: `c${d}`}.b }e` + 1')
        self.assertEqual(toks[0], ('template-head', '`a${'))
        self.assertEqual(toks[-3], ('template-tail', '}e`'))
        self.assertEqual(toks[-1], ('number', '1'))

    def test_line_numbers_and_newlines(self) -> None:
        toks = tokenize('a\n/* x\ny */ b `\n` c')
        self.assertEqual([(t.text, t.line, t.newline_before) for t in toks],
                         [('a', 1, False), ('b', 3, True), ('`\n`', 3, False), ('c', 4, False)])


class PageAssembly(unittest.TestCase):
    def test_css_imports_inlined_in_order(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, 'main.css').write_text('@import url("a.css");\n@import url(\'b.css\');\nbody{}\n')
            Path(tmp, 'a.css').write_text('.a{}')
            Path(tmp, 'b.css').write_text('.b{}\n')
            self.assertEqual(inline_css(Path(tmp, 'main.css')), '.a{}\n.b{}\nbody{}\n')

    def test_placeholders(self) -> None:
        values = {'name': 'A & B', 'page': {'title': '"T"'}}
        self.assertEqual(fill_placeholders('{{name}}|{{ page.title }}', values), 'A &amp; B|&quot;T&quot;')
        with self.assertRaises(SiteError):
            fill_placeholders('{{page.missing}}', values)


if __name__ == '__main__':
    unittest.main()
