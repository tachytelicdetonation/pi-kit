/**
 * pi-pretty: FFF-backed @-mention autocomplete provider.
 *
 * Wraps the built-in autocomplete provider and replaces the @-mention file
 * suggestions with FFF frecency-ranked file search results.
 */
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import type { FileFinder } from "@ff-labs/fff-node";
export declare function createFffAutocompleteProvider(current: AutocompleteProvider, getFinder: () => FileFinder | null): AutocompleteProvider;
//# sourceMappingURL=autocomplete.d.ts.map