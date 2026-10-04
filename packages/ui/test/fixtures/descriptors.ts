/**
 * Hand-emitted fixtures mirroring examples/TeamTasks.can and ExpenseFlow.can.
 * These stand in for lane 1 emission until the compiler produces real
 * descriptors; they are test-only and advertise no production support.
 */
import type {
  MessageDescriptor,
  PageDescriptor,
} from "../../../contracts/src/presentation.js";
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
