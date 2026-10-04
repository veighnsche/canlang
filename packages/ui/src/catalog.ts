/**
 * Single authored definition of every presentation component owned by lane 05.
 * Entries name the Can primitive, the @canlang/ui factory, its contract props
 * shape and its availability; implementation slices flip `planned` to
 * `implemented` as factories land. Envelope mirrors the L1/L2 catalog shape;
 * unification with the shared envelope is a later L1/L7 join.
 */
import type {
  ComponentCatalog,
  ComponentCatalogEntry,
} from "../../contracts/src/presentation.js";

export const LANE05_CATALOG_VERSION = "0.1.0-lane05-draft";

const ENTRIES: ReadonlyArray<ComponentCatalogEntry> = [
  { id: "page-shell", js: "renderPage", owner: "lane-05", kind: "component", signature: "renderPage(context, descriptor, children, shell?): RenderPageFn", availability: "implemented", notes: "S2: drawer shell, account menu, settings frame, partials." },
  { id: "navigation", js: "buildNavigation", owner: "lane-05", kind: "component", signature: "buildNavigation(candidates, outcomes, options): NavigationResult", availability: "implemented", notes: "S2: discovery shaping; candidates via selectDiscoveryCandidates." },
  { id: "card", js: "card", owner: "lane-05", kind: "component", signature: "card(props: CardProps)", availability: "implemented", notes: "S3." },
  { id: "title", js: "title", owner: "lane-05", kind: "component", signature: "title(props: TitleProps)", availability: "implemented", notes: "S3." },
  { id: "text", js: "text", owner: "lane-05", kind: "component", signature: "text(props: TextProps)", availability: "implemented", notes: "S3." },
  { id: "content", js: "content", owner: "lane-05", kind: "component", signature: "content(props: ContentProps)", availability: "implemented", notes: "S3." },
  { id: "list", js: "list", owner: "lane-05", kind: "component", signature: "list(props: ListProps)", availability: "implemented", notes: "S3 renderers; S5 adds search/filter/order/pagination controls." },
  { id: "table", js: "table", owner: "lane-05", kind: "component", signature: "table(props: TableProps)", availability: "implemented", notes: "S3 renderers; S5 adds controls." },
  { id: "state", js: "renderState", owner: "lane-05", kind: "component", signature: "renderState(props: SharedStateProps)", availability: "implemented", notes: "S3: loading/empty/error; validation/conflict/pending arrive with forms." },
  { id: "board", js: "board", owner: "lane-05", kind: "component", signature: "board(props: BoardProps)", availability: "planned", notes: "S7: enum-grouped cards, no drag/drop." },
  { id: "calendar", js: "calendar", owner: "lane-05", kind: "component", signature: "calendar(props: CalendarProps)", availability: "planned", notes: "S7: date-grouped agenda, no drag/resize." },
  { id: "metrics", js: "metrics", owner: "lane-05", kind: "component", signature: "metrics(props: MetricsProps)", availability: "planned", notes: "S7: labeled typed scalars (Stat), not a chart engine." },
  { id: "copy", js: "copy", owner: "lane-05", kind: "component", signature: "copy(props: CopyProps)", availability: "planned", notes: "S7: clipboard button." },
  { id: "details", js: "details", owner: "lane-05", kind: "component", signature: "details(props: DetailsProps)", availability: "planned", notes: "S6: Collapse or activated drawer." },
  { id: "history", js: "history", owner: "lane-05", kind: "component", signature: "history(props: HistoryProps)", availability: "planned", notes: "S6: authorized audit Collapse." },
  { id: "tabs", js: "tabs", owner: "lane-05", kind: "component", signature: "tabs(props: TabsProps)", availability: "planned", notes: "S6: bound/unbound view panels." },
  { id: "form", js: "form", owner: "lane-05", kind: "component", signature: "form(props: FormProps)", availability: "planned", notes: "S4: typed bound forms, drawer/inline." },
  { id: "edit", js: "edit", owner: "lane-05", kind: "component", signature: "edit(props: EditProps)", availability: "planned", notes: "S4: canonical update control." },
  { id: "delete", js: "deleteRecord", owner: "lane-05", kind: "component", signature: "deleteRecord(props: DeleteProps)", availability: "planned", notes: "S4: archive/remove mode; `delete` is reserved, hence the js name." },
  { id: "action", js: "action", owner: "lane-05", kind: "component", signature: "action(props: ActionProps)", availability: "planned", notes: "S4: single bound operation." },
  { id: "actions", js: "actions", owner: "lane-05", kind: "component", signature: "actions(props: ActionsProps)", availability: "planned", notes: "S4: grouped bound operations." },
  { id: "settings", js: "renderSettingsPanel", owner: "lane-05", kind: "component", signature: "renderSettingsPanel(props: SettingsPanelProps)", availability: "planned", notes: "S6: base + preference panels for the S2 frame." },
  { id: "export", js: "exportControl", owner: "lane-05", kind: "component", signature: "exportControl(props: ExportProps)", availability: "planned", notes: "S5/S7: shared CSV-export toolbar control." },
  { id: "print", js: "printControl", owner: "lane-05", kind: "component", signature: "printControl(props: PrintProps)", availability: "planned", notes: "S7: shared Print control." },
  { id: "file", js: "fileControl", owner: "lane-05", kind: "component", signature: "fileControl(props: FileProps)", availability: "planned", notes: "S7: authorized file/media links and inputs." },
  { id: "review", js: "review", owner: "lane-05", kind: "component", signature: "review(props: ReviewProps)", availability: "planned", notes: "S7: source-derived company-policy review presentation." },
  { id: "csv-import", js: "csvImport", owner: "lane-05", kind: "component", signature: "csvImport(props: CsvImportProps)", availability: "planned", notes: "S7: import=csv panel with optional review." },
];

export const UI_CATALOG: ComponentCatalog = {
  catalog_version: LANE05_CATALOG_VERSION,
  language_version: null,
  entries: ENTRIES,
};
