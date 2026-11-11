# Instructions for coding agents

WhichTalk is one planner app shared by every conference. A conference is a folder in
`conferences/<id>/`: a settings file and the program. Adding one is a data task, not a code task.
People read [CONTRIBUTING.md](CONTRIBUTING.md); this file is the same process, in order, with the
rules an agent tends to miss.

## Ground rules

- **Do not change `src/` or `whichtalk/` to add a conference.** If a conference truly needs other
  behavior, stop and ask: it becomes a new field in `conference.json`, read in
  `src/data/conference.js`, which is a separate change.
- **Never edit `docs/` by hand.** Everything there is built. Rebuild instead.
- **Run Python as `python3 -I whichtalk ...`**, from the repository root. The build uses the
  standard library only; do not add dependencies.
- **Use only the public program** (titles, speakers, rooms, times, abstracts) from the official
  site or an export the organizers publish. Follow the site's terms and `robots.txt`. Do not
  invent, guess or fill in program data: leave a field out when the source does not give it.
- **Keep event ids stable.** Saved plans in people's browsers refer to them. When you update a
  program, an item that already exists keeps its id; new items get new ids; never renumber.
- **Never set or change `storageNamespace`** on a conference people have used.

## Add a conference

### 1. Create the folder

```sh
python3 -I whichtalk new yourconf-2027 --name "YourConf 2027"
```

The id is the series and the year, lowercase, with dashes. This copies `conferences/_template/`
and fills in `id`, `name`, `shortName`, `output` (`docs/yourconf/2027`), `page.title` and
`page.canonical`.

To start from something closer, copy another conference instead:

```sh
python3 -I whichtalk new yourconf-2028 --name "YourConf 2028" --from yourconf-2027
python3 -I whichtalk new otherconf-2027 --name "OtherConf 2027" --from example-2026
```

`--from` skips the `cache/` folder and drops `storageNamespace`, so the new conference starts with
its own storage. `conferences/example-2026/` is a complete made-up conference that uses every
optional feature (venue walking times, day labels, a theme): read it before writing settings.

### 2. Fill in `conference.json`

Every field is described in [`conferences/_template/README.md`](conferences/_template/README.md).
After `new`, still update by hand:

- `page.description`, `page.ogDescription`, `page.officialSchedule`, `page.organizer`,
  `page.sourceName`;
- `home.summary` (`"City · Month 2027"`) and `home.badge`, or remove `home` to keep the
  conference off the whichtalk.com homepage;
- `locations`: one per site, with the UTC offset and zone abbreviation **during the conference**
  (mind daylight saving time) and the venue name. `defaultLocation` is the main site's key. For
  several sites, add an "All sites" entry with `"all": true`, like `neurips-2026`;
- `tracks`: group the program's `kind` values. Every kind used in the events must appear in some
  track's `kinds`, or it falls into `fallbackTrack`. Mark tracks of papers with `"papers": true`;
- `source`: keep `{"type": "events-file", "path": "events.json"}` unless a scraper already exists
  for the conference's website software (see `whichtalk/sources/`).

### 3. Write `events.json`

```json
{"format": "whichtalk-events", "version": 1, "events": [ ... ]}
```

One entry per keynote, session, talk, poster, workshop or break. Convert the published program
with a script if there is one to convert; keep that script out of the repository unless it is
asked for.

- `start` is the **local time at the event's location** (`"2027-06-08T09:00"`), not UTC. Give
  `end` or `durationMinutes`, never both. Leave `start` out when the time is not announced yet.
- Talks inside a session and posters inside a poster session point to it with `parent`.
- Multi-site programs set `location` on each event (a key from `locations`); it defaults to
  `defaultLocation`.
- `abstract`, `authors`, `institutions`, `links`, `openreviewId` are optional. Include them when
  the source has them: abstracts drive search and suggestions.
- Unknown fields are errors, so a typo is reported rather than ignored.

### 4. Check and build

```sh
python3 -I whichtalk check yourconf-2027
python3 -I whichtalk build yourconf-2027
```

Fix every error `check` reports before building. `build` writes the planner to the `output`
folder and, when the conference has `home.listed`, also regenerates `docs/index.html`,
`docs/404.html`, `docs/robots.txt` and `docs/sitemap.xml`.

### 5. Look at it

```sh
python3 -m http.server 8000 --directory docs
```

Open `http://localhost:8000/yourconf/2027/`. To see a day of the conference before it happens,
add `?now=2027-06-08T10:30:00%2B02:00` (an ISO time with its offset). Check, with the browser
console open:

- Today shows the right day, time and zone; the Schedule's days and rooms match the official program;
- search finds a speaker and a title; starring an item adds it to My plan;
- every site in `locations` shows its own times.

### 6. Run the tests

```sh
python3 -I -m unittest discover tests
```

The end-to-end suite (`node tests/e2e.mjs`) runs against NeurIPS 2026 only; run it when you
changed anything outside `conferences/<id>/`, as described in CONTRIBUTING.md.

### 7. Open the pull request

Include `conferences/<id>/`, the built `docs/<series>/<year>/` and, if the conference is listed,
the regenerated `docs/index.html`, `docs/404.html`, `docs/robots.txt` and `docs/sitemap.xml`.
Say where the program data comes from. Go through the checklist in CONTRIBUTING.md.

## Update a conference

Programs change before and during a conference. Edit `events.json` (or rerun the scraper), keep
the ids of existing items, then check, build and look again. When a saved item's time or room
changes, people see it under "Since your last visit", so update the item in place; never delete
and re-add an item that only moved.

## Where things are

| Path | What it is |
|---|---|
| `conferences/<id>/` | One conference: `conference.json`, `events.json`, `cache/`, optional `static/` |
| `conferences/_template/` | What `new` copies, with the field reference in its README |
| `conferences/example-2026/` | A complete made-up conference |
| `whichtalk/` | The build and the CLI (`build`, `check`, `list`, `new`, `home`) |
| `whichtalk/sources/` | Scrapers for conference website software |
| `src/` | The planner app, shared by every conference (do not change for a conference) |
| `src/home.html` | The whichtalk.com homepage template |
| `docs/` | The built site, published by GitHub Pages (never edit by hand) |
| `tests/` | Unit tests (Python) and the end-to-end suite (Node and Chrome) |
