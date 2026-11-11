# Contributing to WhichTalk

WhichTalk is one planner app shared by every conference. Each conference is a folder of
settings and data in `conferences/`, so adding one usually takes no code at all.

Working with a coding agent? Point it at [AGENTS.md](AGENTS.md): the same steps, in order, with
the rules it must follow.

## Add a conference

1. **Check the data can be used.** Use only the public program (titles, speakers, rooms, times,
   abstracts) from the official website or an export the organizers publish. Follow the site's
   terms and `robots.txt`. When in doubt, ask the organizers first.
2. **Create the folder.**
   ```sh
   python3 -I whichtalk new yourconf-2027 --name "YourConf 2027"
   ```
   This copies [`conferences/_template/`](conferences/_template/) to `conferences/yourconf-2027/`.
   Its README describes every field. [`conferences/example-2026/`](conferences/example-2026/) is a
   complete made-up conference to copy from.
3. **Describe the conference** in `conference.json`: name, sites and time zones, the tracks that
   group the program's event kinds, the official links. Add `venue` for walking times, `dayLabels`
   to name the days, `theme` for an accent color, and an `og.png` in the folder's `static/` for
   link previews.
4. **Add the program** to `events.json`: one entry per talk, session, poster, workshop or break,
   with a stable numeric `id`. Saved plans refer to these ids, so keep them when you update the file.
5. **Check and build.**
   ```sh
   python3 -I whichtalk check yourconf-2027
   python3 -I whichtalk build yourconf-2027
   python3 -m http.server 8000 --directory docs   # open http://localhost:8000/yourconf/2027/
   ```
   Try Today, Schedule, search, starring and My plan. To build the made-up conference for
   comparison, run `python3 -I whichtalk build example-2026` and open `_site/example/2026/`.
6. **Open a pull request** with the conference folder and the built `docs/<series>/<year>/`.

## Sources

`"source"` in `conference.json` says where the program comes from:

- **`events-file`** (recommended): the program as `events.json` in the conference folder. Write it
  by hand, convert an export, or generate it with your own script.
- **A scraper** in `whichtalk/sources/<name>/`, for website software that hosts many conferences.
  `neurips-cc` reads neurips.cc and may suit other sites on the same software. A scraper must use
  the Python standard library only, obey `robots.txt`, wait at least one second between requests,
  send WhichTalk's User-Agent, and cache what it fetches in `conferences/<id>/cache/`. The cache is
  committed, so anyone can rebuild with `--offline`.

## Change the app or the build

- `src/` is the app (ES modules, no dependencies). Nothing conference-specific belongs there: if a
  conference needs different behavior, add a field to `conference.json` and read it in
  `src/data/conference.js`.
- `whichtalk/` is the build (Python 3.9+, standard library only).
- `src/home.html` is the whichtalk.com homepage. Build it with `python3 -I whichtalk home`; it lists
  every conference with `home.listed` and takes its pictures and video from `static/home/`. The
  same command writes `404.html` (from `src/404.html`, the page for unknown addresses),
  `robots.txt` and `sitemap.xml`.
- Run the tests before opening a pull request:
  ```sh
  python3 -I -m unittest discover tests
  python3 -I whichtalk build neurips-2026 --offline
  python3 -m http.server 8000 --directory docs &
  node tests/e2e.mjs --url http://localhost:8000/neurips/2026/   # Node 24 and Google Chrome
  ```

## Pull request checklist

- [ ] `python3 -I whichtalk check <id>` passes
- [ ] the built page opens with no errors in the browser console
- [ ] event ids are stable (an update keeps the ids of existing items)
- [ ] only public program data, with its source in `page.officialSchedule`
- [ ] the unit tests pass

## License

Code contributions are released under the [GNU Affero General Public License v3.0](LICENSE)
(AGPL-3.0-only), like the rest of the code. Program data stays with its organizers and authors
and is not covered by it.
