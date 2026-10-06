/**
 * Hand-emitted fixtures mirroring examples/TeamTasks.can and ExpenseFlow.can.
 * These stand in for lane 1 emission until the compiler produces real
 * descriptors; they are test-only and advertise no production support.
 */
import type {
  AdmitFn,
  MessageDescriptor,
  PageDescriptor,
  RenderFn,
} from "@canlang/contracts";
import { message } from "../../src/messages.js";

export const TEAMTASKS_MESSAGES = {
  add: message("Add", { nl: "Toevoegen" }),
  fieldTitle: message("Title", { nl: "Titel" }),
  done: message("Done", { nl: "Klaar" }),
  taskCount: (n: bigint): MessageDescriptor =>
    message(
      "{n, plural, one {# task} other {# tasks}}",
      { nl: "{n, plural, one {# taak} other {# taken}}" },
      { n: { type: "int", value: n } },
    ),
} as const;

export type StaticPageMeta = Omit<PageDescriptor, "admit" | "render">;

export const TEAMTASKS_PAGES: StaticPageMeta[] = [
  {
    owner: "TeamTasks",
    path: "/",
    title: message("Team tasks", { nl: "Teamtaken" }),
    description: message("Add work, assign teammates, and track what is finished.", {
      nl: "Voeg werk toe, wijs teamleden toe en volg wat klaar is.",
    }),
  },
  {
    owner: "TeamNotes",
    path: "/notes",
    title: message("Team notes", { nl: "Teamnotities" }),
    description: message("Write and browse the team's notes.", {
      nl: "Schrijf en bekijk de notities van het team.",
    }),
  },
];

export const EXPENSE_PAGES: StaticPageMeta[] = [
  {
    owner: "reporting",
    path: "/reports",
    title: message("Expense summary", { nl: "Onkostenoverzicht" }),
  },
  {
    owner: "expense",
    path: "/expenses/review",
    title: message("Expense review", { nl: "Onkostenbeoordeling" }),
  },
];

/**
 * Navigation fixtures: full descriptors with stub admit/render. Admission is
 * the dispatcher's call; navigation tests pair these with explicit outcome
 * maps instead of invoking `admit`.
 */
const stubAdmit: AdmitFn = async () => ({});
const stubRender: RenderFn = async () => "";

function fullPage(meta: StaticPageMeta): PageDescriptor {
  return { ...meta, admit: stubAdmit, render: stubRender };
}

/** Full descriptors for the TeamTasks-app pages (`/` and `/notes`). */
export const TEAMTASKS_FULL_PAGES: PageDescriptor[] = TEAMTASKS_PAGES.map(fullPage);

/** Full descriptors for the Expense-app pages (`/reports`, `/expenses/review`). */
export const EXPENSE_FULL_PAGES: PageDescriptor[] = EXPENSE_PAGES.map(fullPage);

/** Dynamic route: intrinsically excluded from discovery. */
export const DYNAMIC_INVOICE_PAGE: PageDescriptor = fullPage({
  owner: "billing",
  path: "/invoices/{Invoice.id}",
  title: message("Invoice details"),
});

/** Hidden page: `nav="none"` opts out of discovery. */
export const HIDDEN_ADMIN_PAGE: PageDescriptor = fullPage({
  owner: "TeamTasks",
  path: "/admin/secret",
  title: message("Secret admin"),
  nav: "none",
});

function duplicatePage(title: string): PageDescriptor {
  return fullPage({
    owner: "duplicates",
    path: "/dup",
    title: message(title),
  });
}

/** Two distinct objects sharing one (owner, path): dedup keeps the first. */
export const DUPLICATE_PAGES: PageDescriptor[] = [
  duplicatePage("First dup"),
  duplicatePage("Second dup"),
];

/**
 * Ordered/grouped synthetics spanning two owners: negative, default-zero,
 * and large-BigInt orders; explicit string and descriptor groups (including
 * one shared caption across owners, which must not merge); tied orders.
 */
export const SYNTHETIC_PAGES: PageDescriptor[] = [
  fullPage({
    owner: "alpha",
    path: "/a-tie-first",
    title: message("A tie first"),
    order: 10n,
  }),
  fullPage({
    owner: "alpha",
    path: "/a-tie-second",
    title: message("A tie second"),
    order: 10n,
  }),
  fullPage({
    owner: "alpha",
    path: "/a-negative",
    title: message("A negative"),
    order: -5n,
  }),
  fullPage({
    owner: "alpha",
    path: "/a-default-order",
    title: message("A default order"),
  }),
  fullPage({
    owner: "alpha",
    path: "/a-big",
    title: message("A big"),
    order: 9007199254740993n,
  }),
  fullPage({
    owner: "alpha",
    path: "/a-shared-one",
    title: message("A shared one"),
    group: "Shared",
    order: 1n,
  }),
  fullPage({
    owner: "alpha",
    path: "/a-shared-two",
    title: message("A shared two"),
    group: "Shared",
    order: 2n,
  }),
  fullPage({
    owner: "alpha",
    path: "/a-team-one",
    title: message("A team one"),
    group: message("Team", { nl: "Team" }),
    order: 3n,
  }),
  fullPage({
    owner: "alpha",
    path: "/a-team-two",
    title: message("A team two"),
    group: message("Team", { nl: "Ploeg" }),
    order: 4n,
  }),
  fullPage({
    owner: "beta",
    path: "/b-negative",
    title: message("B negative"),
    order: -10n,
  }),
  fullPage({
    owner: "beta",
    path: "/b-default",
    title: message("B default"),
  }),
  fullPage({
    owner: "beta",
    path: "/b-shared",
    title: message("B shared"),
    group: "Shared",
    order: 1n,
  }),
];
