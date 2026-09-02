// stageKey.js
//
// ONE definition of how a stage name becomes a stage key.
//
// Extracted from handover.service (2026_136) when planImport needed the same
// normalisation. Two copies would let "UAT" typed in the importer and "uat"
// typed on the checklist land in two different groups on the same project —
// which is precisely the free-text degradation this function exists to stop,
// arriving through a second implementation instead of through user input.
//
// Its own file rather than an export from handover.service, because that
// module reaches routes/orgAdmin.routes for the diagnostic config and
// therefore pulls in express and most of the app. A caller that needs eight
// lines of string handling should not have to load a web framework to get
// them — and the standalone test harnesses, which run outside the repo with no
// node_modules, could not load it at all.

/**
 * Normalise a user-supplied stage name into a stable key.
 *
 * Lowercased, non-alphanumerics collapsed to underscores. This is what stops
 * "UAT", "uat" and "U.A.T." becoming three separate groups on the same
 * project — the single most likely way a free-text stage field degrades once
 * a few hundred projects are using it.
 */
function stageKeyFrom(input) {
  return String(input || '')
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

module.exports = { stageKeyFrom };
