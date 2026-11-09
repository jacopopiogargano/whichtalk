# Conference folder

Everything WhichTalk knows about one conference lives in its folder,
`conferences/<id>/`. The app and the build are shared by every conference.

```
conferences/<id>/
  conference.json   who, where, when, how the program is organized, where the data comes from
  events.json       the program (for "source": {"type": "events-file"})
  cache/            pages fetched by a scraper source, committed so builds are reproducible
  static/           optional files that replace the shared ones, e.g. og.png for link previews
```

Start with `python3 -I whichtalk new <id> --name "YourConf 2027"`, which copies this folder and
fills in the names. See `conferences/example-2026/` for a complete made-up conference.

## conference.json

### Required

| Field | Example | What it is |
|---|---|---|
| `id` | `"yourconf-2027"` | Same as the folder name: lowercase letters, digits, dashes |
| `name` | `"YourConf 2027"` | Full name, shown in titles and exports |
| `shortName` | `"YourConf"` | Series name without the year, used in sentences and file names |
| `output` | `"docs/yourconf/2027"` | Where the site is built; under `docs/` it is published at whichtalk.com/yourconf/2027 |
| `page.title` | `"WhichTalk · YourConf 2027"` | Browser tab title |
| `page.description`, `page.ogDescription` | | Search and link-preview text |
| `page.canonical` | `"https://whichtalk.com/yourconf/2027/"` | Public address of the planner |
| `page.officialSchedule` | | Link to the official program |
| `page.organizer` | `"the YourConf organizers"` | Completes "not affiliated with or endorsed by ..." |
| `page.sourceName` | `"yourconf.org"` | Where the data comes from, as shown to people |
| `locations` | | One entry per site: `key`, `name`, `utcOffsetHours` during the conference, `zone` (e.g. `"CEST"`), `venue` |
| `defaultLocation` | `"MAIN"` | Key of the main site |
| `tracks` | | Groups of event kinds used for filters and colors: `key`, `label`, `singular`, `kinds` (the `kind` values in your events) |
| `hiddenTracks` | `["break"]` | Tracks hidden until someone turns them on |
| `fallbackTrack` | `"other"` | Track for kinds no track lists |
| `kindLabels` | `{"Session": "Talk session"}` | Optional display names for kinds; `"*Invited Talk"` matches any kind ending in "Invited Talk" |
| `source` | `{"type": "events-file", "path": "events.json"}` | Where the program comes from (see below) |

### Optional

| Field | Default | What it does |
|---|---|---|
| `home` | not listed | `{"listed": true, "summary": "City · June 2027", "badge": "’27"}` puts the conference on the whichtalk.com homepage (needs an `output` under `docs/`) |
| `tracks[].papers` | `false` | Items of this track are papers: they go to the reading list and BibTeX export |
| `locations[].all` | `false` | Marks an "All sites" choice for multi-site conferences |
| `urls` | no links | `event` (`{id}`), `poster` (`{id}`), `openreview` (`{openreviewId}`) link templates |
| `dayLabels` | none | Names days by what fills them: `[{"label": "Tutorials", "tracks": ["tutorial"]}, {"label": "Main", "title": "Main conference", "tracks": ["talk", "poster"]}]` |
| `containerKinds` | `[]` | Kinds that only group talks (shown as "Talks not yet announced" while empty) |
| `genericSessionTitles` | none | Regular expression for session titles that say nothing about content, e.g. `"Poster Session"` |
| `notes.untimed` | a generic sentence | Text above the list of items without a time |
| `venue` | no walking times | Walking-time model: rooms matched to zones and buildings, minutes between buildings. See `example-2026` |
| `theme` | WhichTalk blue | Accent colors: `{"light": {"accent", "accentMark", "accentSoft"}, "dark": {...}}`. Keep text contrast at 4.5:1 or more |
| `storageNamespace` | `"whichtalk:<id>:"` | Browser storage prefix; never change it after people have used the planner |

## events.json

```json
{"format": "whichtalk-events", "version": 1, "events": [ ... ]}
```

| Field | Required | What it is |
|---|---|---|
| `id` | yes | Positive whole number, unique, stable across updates (saved plans refer to it) |
| `kind` | yes | One of the `kinds` in your tracks |
| `title` | yes | |
| `authors` | | List of names |
| `room` | | |
| `location` | | Location key; defaults to `defaultLocation` |
| `start` | | Local time at the location, `"2027-06-08T09:00"`, or with an offset (`"...+02:00"`, `"...Z"`). Leave it out when the time is not known yet |
| `end` or `durationMinutes` | with `start` | One of the two, never both |
| `parent` | | `id` of the session this item belongs to (talks in a session, posters in a poster session) |
| `abstract` | | Description, loaded on demand and used for search and suggestions |
| `links` | | `[["Label", "https://..."]]` |
| `openreviewId`, `poster`, `topic`, `institutions` | | Optional extras |

Unknown fields are reported as errors, so a typo does not go unnoticed.

Check your files with `python3 -I whichtalk check <id>` and build with
`python3 -I whichtalk build <id>`.
