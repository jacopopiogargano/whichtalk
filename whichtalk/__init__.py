"""WhichTalk build tools: read a conference program, encode it and build the static site.

Modules, in the order a build uses them:
  config    conferences/<id>/conference.json, checked (checks: the problem collector)
  sources   one adapter per `source.type`, each giving a model.Program of normalized events: the
            program file in the conference folder (events_file) or a scraper subpackage, which uses
            fetch (polite HTTP client), cache (the conference's cache/ folder) and tex (LaTeX to Unicode)
  keywords  distinctive terms from each abstract
  dataset   the embedded catalog and the abstract shards
  bundle    ES modules under src/ -> one classic script (jslex, jsmodule: the tokenizer and module reader)
  site      page template, styles and theme, atomic writes (files), static files
  home      the homepage listing the conferences
  scaffold  `new`: a conference folder from the template
  pipeline  the build, check and home commands; __main__ is the command line
"""
__version__ = '1.0.0'
