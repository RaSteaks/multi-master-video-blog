"""Offline regressions for the Kodak collector's download/parse boundary."""
import importlib.util
import concurrent.futures
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("collector", Path(__file__).with_name("collect-kodak-film-data.py"))
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class CollectorTests(unittest.TestCase):
    def test_network_workers_never_open_pdfs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            index = root / "index"
            index.mkdir()
            with collector.fitz.open() as pdf:
                page = pdf.new_page()
                page.insert_text((50, 50), "KODAK density characteristic curve E-4050")
                data = pdf.tobytes()
            original_open = collector.fitz.open
            main_thread = threading.get_ident()
            network_threads = []
            parse_threads = []
            def get(url):
                network_threads.append(threading.get_ident())
                return SimpleNamespace(content=data, url=url)
            def open_pdf(*args, **kwargs):
                parse_threads.append(threading.get_ident())
                self.assertEqual(threading.get_ident(), main_thread)
                return original_open(*args, **kwargs)
            with patch.object(collector, "ROOT", root), patch.object(collector, "INDEX", index), patch.object(collector, "ASSETS", root / "assets"), patch.object(collector, "get", get), patch.object(collector.fitz, "open", open_pdf):
                with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                    futures = [pool.submit(collector.fetch_download, {"url": f"https://example.test/{i}.pdf"}) for i in range(8)]
                    results = [collector.download(f.result()) for f in concurrent.futures.as_completed(futures)]
                self.assertTrue(all(d["status"] == "downloaded" for d in results))
                self.assertTrue(all(d["density_keyword_pages"] == [1] for d in results))
                self.assertEqual(len(list((root / "assets").glob("*/*.pdf"))), 1)
                self.assertEqual(len(parse_threads), 8)
                self.assertTrue(all(t != main_thread for t in network_threads))

    def test_failed_network_and_non_pdf_payload_are_recorded(self):
        with patch.object(collector, "get", side_effect=OSError("offline")):
            self.assertEqual(collector.download(collector.fetch_download({"url": "https://example.test/a.pdf"}))["status"], "failed")
        with patch.object(collector.fitz, "open", side_effect=AssertionError("must not parse HTML")):
            result = collector.download(({"url": "https://example.test/a.pdf"}, b"<html/>", "https://example.test/a.pdf"))
            self.assertEqual(result["status"], "failed")
            self.assertIn("not a PDF", result["error"])


if __name__ == "__main__":
    unittest.main()
