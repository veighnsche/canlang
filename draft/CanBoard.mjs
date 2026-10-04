import {
  action,
  all,
  require as check,
  count,
  create,
  datetime,
  date,
  hasRole,
  local_instant,
  records,
  same,
  set,
} from "@canlang/stdlib";
import {
  actions,
  card,
  details,
  edit,
  form,
  history,
  list,
  message,
  renderPage,
  tab,
  table,
  tabs,
  text,
} from "@canlang/ui";
import { Location } from "./rent_catalog.mjs";

/* Handwritten desired target; every import is a proposed, unimplemented contract.
 * See DESIGN §13. The registry is linked once. Trusted c carries invocation data
 * and inherited query authority; records(c,model,{parent?,where?,order?,limit?,archived?})
 * preserves owner/team bounds, expiry and work limits. Viewer grants apply before
 * filtering and aggregation; pure derives inherit caller mode. Limits reject excess.
 * CRUD when callbacks inspect a normalized candidate before this write is staged;
 * final invariants see staged state. Shared admission owns versions, locks, replay
 * and atomic effects. UI factories own daisyUI/HTMX, schemas, escaping and grants.
 * No compiler, stdlib, renderer, adapter or example runner is implemented here.
 */

const label_Meeting_finalized = message("Finalized", { nl: "Definitief" });

const label_Agenda_paper = message("Paper", { nl: "Vergaderstuk" });

export const Action = "board.Action";

export const complete = "board.complete";

/* Finalized-record read-result composition declares minutes, paper references,
 * decisions and amendments for the shared authorized Print control. ActionOrigin
 * exposes only source titles to assignees. Votes/quorum are not inferred.
 * Imports, guards, immutable files and inline BDD execution remain proposed runtime work.
 */
const boardPageDescriptor = {
  owner: "board",
  path: "/board",
  title: message("Board records", { nl: "Bestuursverslagen" }),
  description: message(
    "Read ordered papers and retain the finalized minutes with amendments.",
    { nl: "Lees stukken op volgorde en bewaar de definitieve notulen met aanvullingen." },
  ),
  admit: async (c, routeBindings = {}) => {
    check(
      hasRole(c, "board.board_member") ||
        hasRole(c, "board.coordinator") ||
        hasRole(c, "board.secretary"),
      "forbidden",
    );
    return {};
  },
  render: boardPage,
};

const actionsPageDescriptor = {
  owner: "board",
  path: "/board/actions",
  title: message("Board actions", { nl: "Bestuursacties" }),
  description: message("Follow assigned outstanding actions under their own operation.", {
    nl: "Volg toegewezen openstaande acties via hun eigen operatie.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "members"), "forbidden");
    return {};
  },
  render: actionsPage,
};

export const appDefinition = {
  id: "CanBoard",
  uses: ["board"],
  description: message(
    "Help the workspace operator's leadership or advisory board prepare meetings about locations, investment, and operating performance, then retain their decisions.",
    {
      nl: "Help het bestuur of de adviesraad van de werkplekexploitant vergaderingen over locaties, investeringen en bedrijfsresultaten voorbereiden en hun besluiten bewaren.",
    },
  ),
  packages: {
    board: {
      label: message("Governance", { nl: "Bestuur" }),
      description: message(
        "Preserve finalized board papers and decisions with attributed amendments and separate action completion.",
        {
          nl: "Bewaar definitieve bestuursstukken en besluiten met toegeschreven aanvullingen en afzonderlijke actieafronding.",
        },
      ),
      roles: {
        board_member: {
          id: "board.board_member",
          label: message("Board member", { nl: "Bestuurslid" }),
        },
        coordinator: {
          id: "board.coordinator",
          label: message("Coordinator", { nl: "Coördinator" }),
        },
        secretary: {
          id: "board.secretary",
          label: message("Board recorder", { nl: "Bestuurssecretaris" }),
        },
      },
    },
  },
  models: {
    "board.Meeting": {
      label: message("Meeting", { nl: "Vergadering" }),
      readGrants: [{ rule: "Meeting.read.1" }],
      locks: ["Meeting.lock.1"],
      fields: {
        title: { type: "text" },
        at: { type: "datetime" },
        timezone: { type: "timezone" },
        location: { type: Location },
        attendance: {
          type: "user",
          array: true,
          label: message("Attendance", { nl: "Aanwezigheid" }),
        },
        minutes: { type: "text", nullable: true, label: message("Minutes", { nl: "Notulen" }) },
        finalized: { type: "bool", default: false, label: label_Meeting_finalized },
        finalized_by: {
          type: "user",
          nullable: true,
          label: message("Finalized by", { nl: "Definitief gemaakt door" }),
        },
        finalized_at: {
          type: "datetime",
          nullable: true,
          label: message("Finalization time", { nl: "Definitief gemaakt op" }),
        },
      },
    },
    "board.Agenda": {
      parent: "board.Meeting",
      label: message("Agenda item", { nl: "Agendapunt" }),
      readGrants: [{ rule: "Agenda.read.1" }],
      locks: ["Agenda.lock.1"],
      fields: {
        title: { type: "text" },
        position: { type: "int", min: 1n, label: message("Position", { nl: "Volgorde" }) },
        paper: { type: "file", nullable: true, label: label_Agenda_paper },
        discussion: {
          type: "text",
          nullable: true,
          label: message("Discussion", { nl: "Bespreking" }),
        },
      },
    },
    "board.Resolution": {
      parent: "board.Meeting",
      label: message("Resolution", { nl: "Besluit" }),
      readGrants: [{ rule: "Resolution.read.1" }],
      locks: ["Resolution.lock.1"],
      fields: {
        title: { type: "text" },
        outcome: {
          type: "enum",
          cases: ["proposed", "accepted", "rejected"],
          default: "proposed",
          label: {
            text: message("Outcome", { nl: "Uitkomst" }),
            values: {
              proposed: message("Proposed", { nl: "Voorgesteld" }),
              accepted: message("Accepted", { nl: "Geaccepteerd" }),
              rejected: message("Rejected", { nl: "Afgewezen" }),
            },
          },
        },
        evidence: { type: "text", nullable: true },
        decided_by: {
          type: "user",
          nullable: true,
          label: message("Decision maker", { nl: "Beslist door" }),
        },
        decided_at: {
          type: "datetime",
          nullable: true,
          label: message("Decision time", { nl: "Beslist op" }),
        },
      },
    },
    "board.Amendment": {
      parent: "board.Meeting",
      label: message("Amendment", { nl: "Aanvulling" }),
      readGrants: [{ rule: "Amendment.read.1" }],
      locks: ["Amendment.lock.1"],
      fields: {
        text: { type: "text", label: message("Text", { nl: "Tekst" }) },
        paper: { type: "file", nullable: true, label: label_Agenda_paper },
        author: { type: "user", server: "actor", label: message("Author", { nl: "Auteur" }) },
      },
    },
    [Action]: {
      parent: "board.Resolution",
      exported: true,
      label: message("Board action", { nl: "Bestuursactie" }),
      readGrants: [{ rule: "Action.read.1" }, { rule: "Action.read.2" }],
      fields: {
        title: { type: "text" },
        owner: { type: "user", label: message("Responsible person", { nl: "Verantwoordelijke" }) },
        due: { type: "date" },
        done: { type: "bool", default: false },
        completed_by: {
          type: "user",
          nullable: true,
          label: message("Completed by", { nl: "Afgerond door" }),
        },
        completed_at: {
          type: "datetime",
          nullable: true,
          label: message("Completion time", { nl: "Afgerond op" }),
        },
      },
    },
  },
  contracts: {
    "board.ActionOrigin": {
      label: message("Action origin", { nl: "Herkomst actie" }),
      fields: { resolution: { type: "text" }, meeting: { type: "text" } },
    },
    "board.WorkItem": {
      exported: true,
      label: message("Authorized work item", { nl: "Toegestaan werkitem" }),
      fields: {
        reference: { type: "text" },
        revision: { type: "int" },
        location: { type: "text", nullable: true },
        title: { type: "text" },
        detail: { type: "text", nullable: true },
        due: { type: "datetime", nullable: true },
        action: { type: "action", targets: ["board.complete"] },
      },
    },
    "board.WorkBatch": {
      exported: true,
      label: message("Authorized work batch", { nl: "Toegestane werkverzameling" }),
      fields: { items: { type: "board.WorkItem", array: true, requiredArray: true, max: 500n } },
    },
  },
  preferences: {
    board: {
      fields: {
        finalized: { type: "bool", nullable: true, default: null, label: label_Meeting_finalized },
        amendments_open: {
          type: "bool",
          default: false,
          label: message("Expand meeting amendments", { nl: "Vergaderaanvullingen uitklappen" }),
        },
      },
    },
  },
  operations: {
    "board.origin": {
      handler: "origin",
      read: true,
      scope: "authority",
      by: ["members", "board.secretary"],
      result: "board.ActionOrigin",
      inputs: { action: { type: Action } },
      description: message(
        "Expose only source titles to an assigned member, never board papers or decision evidence.",
        {
          nl: "Toon alleen brontitels aan een toegewezen lid, nooit bestuursstukken of besluitbewijs.",
        },
      ),
    },
    "board.work": {
      handler: "work",
      exported: true,
      read: true,
      scope: "authority",
      by: ["members", "board.secretary"],
      result: "board.WorkBatch",
      inputs: { locations: { type: "text", array: true } },
      description: message(
        "Return only current eligible work under the canonical completion authority.",
        {
          nl: "Geef alleen actueel uitvoerbaar werk terug binnen de canonieke afrondingsbevoegdheid.",
        },
      ),
    },
    "board.work_detail": {
      handler: "work_detail",
      exported: true,
      read: true,
      scope: "authority",
      by: ["members", "board.secretary"],
      result: "board.WorkItem",
      inputs: { record: { type: "board.Action" } },
      description: message(
        "Revalidate the selected item before presenting its protected canonical action.",
        {
          nl: "Controleer het gekozen item opnieuw voordat de beschermde canonieke actie wordt getoond.",
        },
      ),
    },
    "board.Meeting.create": {
      handler: "createMeeting",
      kind: "create",
      model: "board.Meeting",
      by: "board.coordinator",
      read: false,
      inputs: { fields: ["title", "at", "timezone", "location", "attendance", "minutes"] },
      when: "Meeting",
    },
    "board.Meeting.update": {
      handler: "updateMeeting",
      kind: "update",
      model: "board.Meeting",
      by: "board.coordinator",
      read: false,
      inputs: {
        record: { type: "board.Meeting" },
        changes: { fields: ["title", "at", "timezone", "location", "attendance", "minutes"] },
      },
      when: "Meeting",
    },
    "board.Agenda.create": {
      handler: "createAgenda",
      kind: "create",
      model: "board.Agenda",
      by: "board.coordinator",
      read: false,
      inputs: {
        parent: { type: "board.Meeting" },
        fields: ["title", "position", "paper", "discussion"],
      },
      when: "Agenda",
    },
    "board.Agenda.update": {
      handler: "updateAgenda",
      kind: "update",
      model: "board.Agenda",
      by: "board.coordinator",
      read: false,
      inputs: {
        record: { type: "board.Agenda" },
        changes: { fields: ["title", "position", "paper", "discussion"] },
      },
      when: "Agenda",
    },
    "board.Resolution.create": {
      handler: "createResolution",
      kind: "create",
      model: "board.Resolution",
      by: "board.coordinator",
      read: false,
      inputs: { parent: { type: "board.Meeting" }, fields: ["title"] },
      when: "Resolution",
    },
    "board.Resolution.update": {
      handler: "updateResolution",
      kind: "update",
      model: "board.Resolution",
      by: "board.coordinator",
      read: false,
      inputs: { record: { type: "board.Resolution" }, changes: { fields: ["title"] } },
      when: "Resolution",
    },
    "board.Amendment.create": {
      handler: "createAmendment",
      kind: "create",
      model: "board.Amendment",
      by: "board.secretary",
      read: false,
      inputs: { parent: { type: "board.Meeting" }, fields: ["text", "paper"] },
      when: "Amendment",
    },
    "board.Action.create": {
      handler: "createAction",
      kind: "create",
      model: Action,
      by: "board.secretary",
      read: false,
      inputs: { parent: { type: "board.Resolution" }, fields: ["title", "owner", "due"] },
      when: "Action",
    },
    "board.Action.update": {
      handler: "updateAction",
      kind: "update",
      model: Action,
      by: "board.secretary",
      read: false,
      inputs: { record: { type: Action }, changes: { fields: ["title", "owner", "due"] } },
      when: "Action",
    },
    "board.decide": {
      read: false,
      handler: "decide",
      by: "board.secretary",
      inputs: {
        resolution: { type: "board.Resolution" },
        accept: { type: "bool", label: message("Accept", { nl: "Accepteren" }) },
        evidence: { type: "text" },
      },
      label: message("Record decision", { nl: "Besluit vastleggen" }),
      description: message(
        "Record a manual resolution with evidence before finalizing the meeting.",
        {
          nl: "Leg een handmatig besluit met bewijs vast voordat de vergadering definitief wordt.",
        },
      ),
    },
    "board.finalize": {
      read: false,
      handler: "finalize",
      by: "board.secretary",
      inputs: { meeting: { type: "board.Meeting" } },
      label: message("Finalize minutes", { nl: "Notulen definitief maken" }),
      description: message("Freeze the meeting record and its presented paper versions.", {
        nl: "Maak het vergaderverslag en de gepresenteerde stukversies onveranderlijk.",
      }),
    },
    "board.finalized_record": {
      handler: "finalized_record",
      read: true,
      by: ["board.board_member", "board.coordinator", "board.secretary"],
      result: "board.Meeting",
      inputs: { meeting: { type: "board.Meeting" } },
      label: message("Open printable minutes", { nl: "Afdrukbare notulen openen" }),
      description: message(
        "Retrieve the finalized meeting with its declared papers, decisions, and amendments for authorized printing.",
        {
          nl: "Haal de definitieve vergadering met de gedeclareerde stukken, besluiten en aanvullingen op om bevoegd af te drukken.",
        },
      ),
    },
    "board.complete": {
      read: false,
      handler: "complete",
      exported: true,
      by: ["members", "board.secretary"],
      inputs: { action: { type: Action } },
      description: message(
        "Complete only your assigned action without amending the board decision.",
        { nl: "Rond alleen je toegewezen actie af zonder het bestuursbesluit te wijzigen." },
      ),
    },
  },
  pages: [
    boardPageDescriptor,
    actionsPageDescriptor,
  ],
  disabled: [
    "board.Meeting.delete",
    "board.Agenda.delete",
    "board.Resolution.delete",
    "board.Amendment.update",
    "board.Amendment.delete",
    "board.Action.delete",
  ],
};

export function canApp() {
  const crudWhen = {
    Meeting: (c, row) => !row.finalized,
    Agenda: (c, row) => !row.parent.finalized,
    Resolution: (c, row) => !row.parent.finalized,
    Amendment: (c, row) => row.parent.finalized,
    Action: (c, row) => row.parent.outcome === "accepted",
  };
  return {
    read: {
      "Meeting.read.1": (c, row) =>
        hasRole(c, "board.board_member") ||
        hasRole(c, "board.coordinator") ||
        hasRole(c, "board.secretary"),
      "Agenda.read.1": (c, row) =>
        hasRole(c, "board.board_member") ||
        hasRole(c, "board.coordinator") ||
        hasRole(c, "board.secretary"),
      "Resolution.read.1": (c, row) =>
        hasRole(c, "board.board_member") ||
        hasRole(c, "board.coordinator") ||
        hasRole(c, "board.secretary"),
      "Amendment.read.1": (c, row) =>
        hasRole(c, "board.board_member") ||
        hasRole(c, "board.coordinator") ||
        hasRole(c, "board.secretary"),
      "Action.read.1": (c, row) =>
        hasRole(c, "board.board_member") ||
        hasRole(c, "board.coordinator") ||
        hasRole(c, "board.secretary"),
      "Action.read.2": (c, row) => hasRole(c, "members") && same(row.owner, c.actor),
    },
    locks: {
      "Meeting.lock.1": {
        fields: [
          "title",
          "at",
          "timezone",
          "location",
          "attendance",
          "minutes",
          "finalized",
          "finalized_by",
          "finalized_at",
        ],
        when: (c, row) => row.finalized,
      },
      "Agenda.lock.1": {
        fields: ["title", "position", "paper", "discussion"],
        when: (c, row) => row.parent.finalized,
      },
      "Resolution.lock.1": {
        fields: ["title", "outcome", "evidence", "decided_by", "decided_at"],
        when: (c, row) => row.parent.finalized,
      },
      "Amendment.lock.1": { fields: ["text", "paper", "author"] },
    },
    crudWhen,
    async createMeeting(c, input) {
      check(hasRole(c, "board.coordinator"), "forbidden");
      await create(c, "board.Meeting", input, { when: crudWhen.Meeting });
    },
    async updateMeeting(c, { record, changes }) {
      check(hasRole(c, "board.coordinator"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Meeting });
    },
    async createAgenda(c, input) {
      check(hasRole(c, "board.coordinator"), "forbidden");
      await create(c, "board.Agenda", input, { when: crudWhen.Agenda });
    },
    async updateAgenda(c, { record, changes }) {
      check(hasRole(c, "board.coordinator"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Agenda });
    },
    async createResolution(c, input) {
      check(hasRole(c, "board.coordinator"), "forbidden");
      await create(c, "board.Resolution", input, { when: crudWhen.Resolution });
    },
    async updateResolution(c, { record, changes }) {
      check(hasRole(c, "board.coordinator"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Resolution });
    },
    async createAmendment(c, input) {
      check(hasRole(c, "board.secretary"), "forbidden");
      await create(c, "board.Amendment", input, { when: crudWhen.Amendment });
    },
    async createAction(c, input) {
      check(hasRole(c, "board.secretary"), "forbidden");
      await create(c, Action, input, { when: crudWhen.Action });
    },
    async updateAction(c, { record, changes }) {
      check(hasRole(c, "board.secretary"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Action });
    },
    async decide(c, { resolution, accept, evidence }) {
      check(hasRole(c, "board.secretary"), "forbidden");
      check(!resolution.parent.finalized && evidence.trim() !== "");
      if (accept)
        await set(c, resolution, {
          outcome: "accepted",
          evidence,
          decided_by: c.actor,
          decided_at: c.now,
        });
      else
        await set(c, resolution, {
          outcome: "rejected",
          evidence,
          decided_by: c.actor,
          decided_at: c.now,
        });
    },
    async finalize(c, { meeting }) {
      check(hasRole(c, "board.secretary"), "forbidden");
      check(
        !meeting.finalized &&
          meeting.minutes !== null &&
          (await all(
            records(c, "board.Resolution", { parent: meeting }),
            (resolution) => resolution.outcome !== "proposed",
          )),
      );
      await set(c, meeting, { finalized: true, finalized_by: c.actor, finalized_at: c.now });
    },
    async finalized_record(c, { meeting }) {
      check(
        hasRole(c, "board.board_member") ||
          hasRole(c, "board.coordinator") ||
          hasRole(c, "board.secretary"),
        "forbidden",
      );
      check(meeting.finalized);
      return meeting;
    },
    async complete(c, { action }) {
      check(hasRole(c, "members") || hasRole(c, "board.secretary"), "forbidden");
      check(
        (same(action.owner, c.actor) || hasRole(c, "board.secretary")) &&
          !action.done &&
          action.parent.outcome === "accepted",
      );
      await set(c, action, { done: true, completed_by: c.actor, completed_at: c.now });
    },
    async origin(c, { action }) {
      check(hasRole(c, "members") || hasRole(c, "board.secretary"), "forbidden");
      check(same(action.owner, c.actor) || hasRole(c, "board.secretary"));
      return { resolution: action.parent.title, meeting: action.parent.parent.title };
    },
    async work(c, { locations }) {
      check(hasRole(c, "members") || hasRole(c, "board.secretary"), "forbidden");
      const items = [];
      for await (const item of records(c, "board.Action", {
        where: async (item) =>
          (same(item.owner, c.actor) || hasRole(c, "board.secretary")) &&
          !item.done &&
          item.parent.outcome === "accepted" &&
          ((await count(locations)) === 0n || locations.includes(item.parent.parent.location.id)),
      }))
        items.push({
          reference: item.id,
          revision: item.version,
          location: item.parent.parent.location.id,
          title: item.title,
          detail: item.parent.title,
          due: local_instant(item.due, "00:00", item.parent.parent.timezone, { fold: "earlier" }),
          action: action(c, "board.complete", { action: item }),
        });
      return { items };
    },
    async work_detail(c, { record }) {
      check(hasRole(c, "members") || hasRole(c, "board.secretary"), "forbidden");
      check(
        (same(record.owner, c.actor) || hasRole(c, "board.secretary")) &&
          !record.done &&
          record.parent.outcome === "accepted",
      );
      return {
        reference: record.id,
        revision: record.version,
        location: record.parent.parent.location.id,
        title: record.title,
        detail: record.parent.title,
        due: local_instant(record.due, "00:00", record.parent.parent.timezone, { fold: "earlier" }),
        action: action(c, "board.complete", { action: record }),
      };
    },
  };
}

export async function boardPage(c, bindings) {
  return renderPage(
    c,
    boardPageDescriptor,
    () => [
      card({
        context: c,
        title: message("Meeting intake", { nl: "Vergadering aanmaken" }),
        children: [form({ context: c, operation: "board.Meeting.create" })],
      }),
      list({
        context: c,
        model: "board.Meeting",
        columns: ["title", "at", "location", "finalized"],
        order: ["-at"],
        filter: ["finalized"],
        defaults: { finalized: c.preferences.board.finalized },
        search: ["title"],
        display: "split",
        renderRow: (meeting, v) => [
          // Desired: badge row.finalized — no verified @canlang/ui badge factory yet; awaits the L5 producer contract.
          card({
            context: v,
            title: message("Meeting and attendance", { nl: "Vergadering en aanwezigheid" }),
            children: [
              text({
                context: v,
                values: [
                  meeting.at,
                  meeting.timezone,
                  meeting.location,
                  meeting.attendance,
                  meeting.minutes,
                  meeting.finalized,
                  meeting.finalized_by,
                ],
              }),
              edit({ context: v, operation: "board.Meeting.update", record: meeting }),
              actions({ context: v, operations: ["board.finalize"], boundArgs: { meeting } }),
            ],
          }),
          tabs({
            context: v,
            children: [
              tab({
                context: v,
                caption: message("Agenda and papers", { nl: "Agenda en stukken" }),
                children: [
                  form({
                    context: v,
                    operation: "board.Agenda.create",
                    arguments: { parent: meeting },
                  }),
                  table({
                    context: v,
                    model: "board.Agenda",
                    parent: meeting,
                    columns: ["position", "title", "paper", "discussion"],
                    order: ["position"],
                    renderRow: (agenda, av) =>
                      edit({ context: av, operation: "board.Agenda.update", record: agenda }),
                  }),
                ],
              }),
              tab({
                context: v,
                caption: message("Resolutions and actions", { nl: "Besluiten en acties" }),
                children: [
                  form({
                    context: v,
                    operation: "board.Resolution.create",
                    arguments: { parent: meeting },
                  }),
                  list({
                    context: v,
                    model: "board.Resolution",
                    parent: meeting,
                    columns: ["title", "outcome", "evidence"],
                    renderRow: (resolution, rv) => [
                      // Desired: badge row.outcome — no verified @canlang/ui badge factory yet; awaits the L5 producer contract.
                      actions({
                        context: rv,
                        operations: ["board.decide"],
                        boundArgs: { resolution },
                      }),
                      form({
                        context: rv,
                        operation: "board.Action.create",
                        arguments: { parent: resolution },
                      }),
                      table({
                        context: rv,
                        model: Action,
                        parent: resolution,
                        columns: ["title", "owner", "due", "done"],
                        order: ["due"],
                        filter: ["done"],
                        renderRow: (action, av) => [
                          // Desired: badge row.done — no verified @canlang/ui badge factory yet; awaits the L5 producer contract.
                          actions({
                            context: av,
                            operations: ["board.complete"],
                            boundArgs: { action },
                          }),
                          details({
                            context: av,
                            caption: message("Completion evidence", { nl: "Bewijs afronding" }),
                            children: [
                              text({
                                context: av,
                                values: [action.completed_by, action.completed_at],
                              }),
                            ],
                          }),
                        ],
                      }),
                    ],
                  }),
                ],
              }),
              tab({
                context: v,
                caption: message("Final minutes and amendments", {
                  nl: "Definitieve notulen en aanvullingen",
                }),
                children: [
                  form({
                    context: v,
                    operation: "board.finalized_record",
                    arguments: { meeting },
                    renderResult: (result, scope) => [
                      text({
                        context: scope,
                        values: [
                          result.title,
                          result.at,
                          result.timezone,
                          result.location,
                          result.attendance,
                          result.minutes,
                          result.finalized_by,
                          result.finalized_at,
                        ],
                      }),
                      table({
                        context: scope,
                        model: "board.Agenda",
                        parent: result,
                        columns: ["position", "title", "paper", "discussion"],
                        order: ["position"],
                      }),
                      list({
                        context: scope,
                        model: "board.Resolution",
                        parent: result,
                        columns: ["title", "outcome", "evidence", "decided_by", "decided_at"],
                      }),
                      details({
                        context: scope,
                        caption: message("Recorded amendments", { nl: "Vastgelegde aanvullingen" }),
                        open: c.preferences.board.amendments_open,
                        children: [
                          list({
                            context: scope,
                            model: "board.Amendment",
                            parent: result,
                            renderRow: (amendment, av) =>
                              // Source now uses content row.text + text row.paper,row.author; text() witness retained until the producer contract confirms a content factory.
                              text({
                                context: av,
                                values: [amendment.text, amendment.paper, amendment.author],
                              }),
                          }),
                        ],
                      }),
                    ],
                  }),
                  form({
                    context: v,
                    operation: "board.Amendment.create",
                    arguments: { parent: meeting },
                  }),
                ],
              }),
            ],
          }),
          history({ context: v, record: meeting }),
        ],
      }),
    ],
  );
}

export async function actionsPage(c, bindings) {
  return renderPage(
    c,
    actionsPageDescriptor,
    () =>
      table({
        context: c,
        model: Action,
        columns: ["title", "owner", "due", "done"],
        order: ["due"],
        filter: ["done"],
        display: "split",
        renderRow: (action, v) => [
          // Desired: badge row.done — no verified @canlang/ui badge factory yet; awaits the L5 producer contract.
          form({
            context: v,
            operation: "board.origin",
            arguments: { action },
            renderResult: (result, scope) => [
              text({ context: scope, values: [result.resolution, result.meeting] }),
            ],
          }),
          actions({ context: v, operations: ["board.complete"], boundArgs: { action } }),
          details({
            context: v,
            caption: message("Action evidence", { nl: "Actiebewijs" }),
            children: [text({ context: v, values: [action.completed_by, action.completed_at] })],
          }),
        ],
      }),
  );
}

/* Test-only fixture recipes and inline behavior examples. The future compiler
 * extracts these declarations and erases fixture-only imports from production.
 * Recipes retain identity; dependencies resolve before deferred value callbacks.
 * Each row provisions only seed/common-input/row dependencies and their closure.
 * Common bindings establish the baseline. Inputs, cells and expected values read
 * untouched seeded scope s; overrides apply together, observations use fresh scope.
 * No runner, provisioning implementation or Can-expression interpreter is added.
 */
export const exampleImports = [
  { provider: "rent_catalog", member: "test_site", alias: "test_site" },
];

export function exampleFixtures({ self, other, imported }) {
  const { test_site } = imported;
  const prepared = {
    model: "board.Meeting",
    dependencies: [test_site],
    value: async (c, s) => ({
      title: "Expansion",
      at: datetime("2099-01-01T09:00:00Z"),
      timezone: "Europe/Brussels",
      location: s.test_site,
      minutes: "Recorded discussion",
    }),
  };
  const presented = { dependencies: [], file: async (c, s) => ({}) };
  const replacement = { dependencies: [], file: async (c, s) => ({}) };
  const paper_item = {
    model: "board.Agenda",
    dependencies: [prepared, presented],
    value: async (c, s) => ({
      parent: s.prepared,
      title: "Expansion plan",
      position: 1n,
      paper: s.presented,
      discussion: "Discussed location opening",
    }),
  };
  const decision = {
    model: "board.Resolution",
    dependencies: [prepared],
    value: async (c, s) => ({
      parent: s.prepared,
      title: "Open location",
      outcome: "accepted",
      evidence: "Approved expansion budget",
      decided_by: s.self,
      decided_at: c.now,
    }),
  };
  const correction = {
    model: "board.Amendment",
    dependencies: [prepared, replacement],
    value: async (c, s) => ({
      parent: s.prepared,
      text: "Recorded attendance correction",
      paper: s.replacement,
      author: s.self,
    }),
  };
  const assigned = {
    model: Action,
    dependencies: [decision],
    value: async (c, s) => ({
      parent: s.decision,
      title: "Arrange opening",
      owner: s.self,
      due: date("2099-01-02"),
    }),
  };
  return {
    prepared,
    presented,
    replacement,
    paper_item,
    decision,
    correction,
    assigned,
    examples: [
      {
        operation: "board.Meeting.update",
        dependencies: [prepared],
        inputs: async (c, s) => ({ record: s.prepared, changes: { minutes: "Corrected draft" } }),
        selectors: ["as", "record.finalized"],
        observations: [async (c, s) => s.prepared.minutes],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["board.coordinator", false],
            expected: async (c, s) => ["Corrected draft"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["board.coordinator", true],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "board.Agenda.update",
        dependencies: [paper_item, replacement],
        inputs: async (c, s) => ({ record: s.paper_item, changes: { paper: s.replacement } }),
        selectors: ["as", "record.parent.finalized"],
        observations: [async (c, s) => s.paper_item.paper],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["board.coordinator", false],
            expected: async (c, s) => [s.replacement],
          },
          {
            dependencies: [],
            values: async (c, s) => ["board.coordinator", true],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "board.Amendment.create",
        seed: [paper_item, decision],
        dependencies: [prepared, replacement],
        inputs: async (c, s) => ({
          parent: s.prepared,
          text: "Correction to the recorded attendance",
          paper: s.replacement,
        }),
        selectors: ["as", "parent.finalized"],
        observations: [
          async (c, s) => count(records(c, "board.Amendment", { parent: s.prepared })),
          async (c, s) => s.prepared.minutes,
          async (c, s) => s.paper_item.paper,
          async (c, s) => s.decision.evidence,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["board.secretary", true],
            expected: async (c, s) => [
              1n,
              "Recorded discussion",
              s.presented,
              "Approved expansion budget",
            ],
          },
          {
            dependencies: [],
            values: async (c, s) => ["board.secretary", false],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["board.board_member", true],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "board.decide",
        dependencies: [decision],
        inputs: async (c, s) => ({
          resolution: s.decision,
          accept: true,
          evidence: "Recorded approval",
        }),
        selectors: ["as", "resolution.parent.finalized", "accept", "evidence"],
        observations: [
          async (c, s) => s.resolution.outcome,
          async (c, s) => s.resolution.evidence,
          async (c, s) => s.resolution.decided_by,
          async (c, s) => s.resolution.decided_at,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["board.secretary", false, true, "Recorded approval"],
            expected: async (c, s) => ["accepted", "Recorded approval", s.self, c.now],
          },
          {
            dependencies: [],
            values: async (c, s) => ["board.secretary", false, false, "No funding"],
            expected: async (c, s) => ["rejected", "No funding", s.self, c.now],
          },
          {
            dependencies: [],
            values: async (c, s) => ["board.secretary", false, true, " "],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["board.secretary", true, true, "Recorded approval"],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["board.board_member", false, true, "Recorded approval"],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "board.finalize",
        seed: [paper_item, decision],
        dependencies: [prepared],
        inputs: async (c, s) => ({ meeting: s.prepared }),
        selectors: ["as", "meeting.finalized", "meeting.minutes", "decision.outcome"],
        observations: [
          async (c, s) => s.meeting.finalized,
          async (c, s) => s.meeting.finalized_by,
          async (c, s) => s.meeting.finalized_at,
          async (c, s) => s.paper_item.paper,
          async (c, s) => s.decision.evidence,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["board.secretary", false, "Recorded discussion", "accepted"],
            expected: async (c, s) => [
              true,
              s.self,
              c.now,
              s.presented,
              "Approved expansion budget",
            ],
          },
          {
            dependencies: [],
            values: async (c, s) => ["board.secretary", true, "Recorded discussion", "accepted"],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "board.board_member",
              false,
              "Recorded discussion",
              "accepted",
            ],
            error: "forbidden",
          },
          {
            dependencies: [],
            values: async (c, s) => ["board.secretary", false, null, "accepted"],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["board.secretary", false, "Recorded discussion", "proposed"],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "board.finalized_record",
        seed: [paper_item, decision, correction],
        dependencies: [prepared],
        inputs: async (c, s) => ({ meeting: s.prepared }),
        selectors: ["as", "meeting.finalized"],
        observations: [
          async (c, s) => s.result.minutes,
          async (c, s) => count(records(c, "board.Agenda", { parent: s.result })),
          async (c, s) => count(records(c, "board.Resolution", { parent: s.result })),
          async (c, s) => count(records(c, "board.Amendment", { parent: s.result })),
          async (c, s) => s.paper_item.paper,
          async (c, s) => s.correction.paper,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["board.board_member", true],
            expected: async (c, s) => [
              "Recorded discussion",
              1n,
              1n,
              1n,
              s.presented,
              s.replacement,
            ],
          },
          { dependencies: [], values: async (c, s) => ["public", true], error: "forbidden" },
        ],
      },
      {
        operation: "board.finalized_record",
        dependencies: [prepared],
        inputs: async (c, s) => ({ meeting: s.prepared }),
        selectors: ["as", "meeting.finalized"],
        observations: [async (c, s) => s.result.minutes],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["board.coordinator", false],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "board.complete",
        dependencies: [assigned],
        inputs: async (c, s) => ({ action: s.assigned }),
        selectors: [
          "as",
          "action.owner",
          "action.done",
          "action.parent.outcome",
          "action.parent.parent.finalized",
        ],
        observations: [
          async (c, s) => s.action.done,
          async (c, s) => s.action.completed_by,
          async (c, s) => s.action.completed_at,
          async (c, s) => s.decision.evidence,
          async (c, s) => s.prepared.finalized,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members", s.self, false, "accepted", true],
            expected: async (c, s) => [true, s.self, c.now, "Approved expansion budget", true],
          },
          {
            dependencies: [],
            values: async (c, s) => ["board.secretary", s.other, false, "accepted", true],
            expected: async (c, s) => [true, s.self, c.now, "Approved expansion budget", true],
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", s.other, false, "accepted", true],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", s.self, true, "accepted", true],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", s.self, false, "rejected", true],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["public", s.self, false, "accepted", true],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "board.origin",
        dependencies: [assigned],
        inputs: async (c, s) => ({ action: s.assigned }),
        selectors: ["as", "action.owner", "action.done"],
        observations: [async (c, s) => s.result.resolution, async (c, s) => s.result.meeting],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members", s.self, false],
            expected: async (c, s) => ["Open location", "Expansion"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", s.self, true],
            expected: async (c, s) => ["Open location", "Expansion"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", s.other, false],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["public", s.self, false],
            error: "forbidden",
          },
        ],
      },
    ],
  };
}
