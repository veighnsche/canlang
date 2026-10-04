/* Then-only desired witness for CanLearn (no base .mjs exists).
 * Every @canlang/ui factory below is a proposed, unimplemented contract owned
 * by lane-05; nothing here is verified installed behavior. Given/When lowering
 * and fixture/example extraction are out of scope for this frontend replan.
 */
import { compareDate, first, local_date, records, require as check, hasRole, same } from "@canlang/stdlib";

// Desired: learn.eligible derive mirror (CanLearn.can:26). Grant primitives
// (is_staff, can_work, eligible_terms) are owned by the employee/member_terms
// packages and unwired in this Then-only witness; stubs throw so the seam
// stays explicit for lane-05.
function is_staff() {
  throw new Error("unimplemented: employee.is_staff");
}
function can_work() {
  throw new Error("unimplemented: employee.can_work");
}
function eligible_terms() {
  throw new Error("unimplemented: member_terms.eligible_term");
}
function eligible(account, version) {
  return (
    (version.audience === "staff" &&
      is_staff(account) &&
      version.locations.some((location) => can_work(account, location))) ||
    (version.audience === "member" &&
      eligible_terms(account).some((term) =>
        term.locations.some(
          (location) => version.locations.includes(location) && location.active,
        ),
      ))
  );
}

const coursesCaption = message("Course authoring", { nl: "Cursussen beheren" });

const myLearningPageDescriptor = {
  owner: "learn",
  path: "/learning/mine",
  title: message("My learning", { nl: "Mijn opleidingen" }),
  description: message(
    "Read the exact enrolled content and acknowledge it without a separate testing DSL.",
    {
      nl: "Lees de exacte ingeschreven inhoud en bevestig die zonder afzonderlijke testtaal.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "authenticated"), "forbidden");
    return {};
  },
  render: myLearningPage,
};

const coursesPageDescriptor = {
  owner: "learn",
  path: "/learning/courses",
  title: coursesCaption,
  description: message(
    "Author and publish course versions and inspect attributed completion.",
    {
      nl: "Maak en publiceer cursusversies en bekijk herleidbare afronding.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "learn.instructor"), "forbidden");
    return {};
  },
  render: coursesPage,
};
import {
  action,
  actions,
  alert,
  badge,
  breadcrumbs,
  button,
  calendar,
  card,
  checkbox,
  content,
  edit,
  form,
  input,
  list,
  message,
  modal,
  pagination,
  progress,
  radio,
  renderPage,
  slot,
  steps,
  tab,
  table,
  tabs,
  text,
  textarea,
  title,
} from "@canlang/ui";

export async function myLearningPage(c, bindings) {
  return renderPage(c, myLearningPageDescriptor, () => [
    breadcrumbs({ context: c }),
    tabs({ context: c, preference: "learn.view" }),
    list({
      context: c,
      model: "learn.Enrollment",
      alias: "enrollment",
      where: (enrollment) =>
        same(enrollment.account, c.actor) &&
        (c.preferences.learn.view === "all" ||
          (c.preferences.learn.view === "required" && enrollment.parent.required) ||
          (c.preferences.learn.view === "optional" && !enrollment.parent.required) ||
          (c.preferences.learn.view === "overdue" &&
            enrollment.due !== null &&
            compareDate(enrollment.due, local_date(c.now, c.team.timezone)) < 0 &&
            enrollment.active &&
            enrollment.progress < 100)) &&
        (c.preferences.learn.location === null ||
          enrollment.parent.locations.includes(c.preferences.learn.location)) &&
        (c.preferences.learn.audience === null ||
          same(enrollment.parent.audience, c.preferences.learn.audience)),
      order: {
        by: "learn.order",
        default: ["due", "parent.title"],
        cases: { title: ["parent.title", "due"] },
      },
      display: "split",
      empty: message("No enrolled courses", { nl: "Geen ingeschreven cursussen" }),
      renderRow: (row, view) => [
        badge({ context: view, value: row.parent.audience }),
        text({ context: view, values: [row.parent.title, row.due] }),
        text({ context: view, values: [row.active, row.parent.required] }),
        progress({ context: view, value: row.progress, max: 100 }),
        text({ context: view, values: [row.total] }),
        ...(!row.active || !c.actor.email_verified || !eligible(c.actor, row.parent)
          ? [
              alert({
                context: view,
                children: [
                  text({
                    context: view,
                    values: [
                      message("Lesson access unavailable; your acknowledgments remain in history.", {
                        nl: "Lesinhoud niet beschikbaar; je bevestigingen blijven in de historiek.",
                      }),
                    ],
                  }),
                ],
              }),
            ]
          : []),
        ...(!row.active || !c.actor.email_verified || !eligible(c.actor, row.parent)
          ? [
              card({
                context: view,
                title: message("Acknowledgment history", { nl: "Bevestigingshistoriek" }),
                children: [
                  table({
                    context: view,
                    model: "learn.Completion",
                    parent: row,
                    columns: ["author", "completed"],
                    order: ["completed"],
                    empty: message("No acknowledgments yet", { nl: "Nog geen bevestigingen" }),
                    children: [pagination({ context: view })],
                  }),
                ],
              }),
            ]
          : []),
        steps({
          context: view,
          model: "learn.Lesson",
          parent: row.parent,
          renderItem: (lesson, lv) => [
            title({ context: lv, value: lesson.title }),
            content({ context: lv, value: lesson.content }),
            text({
              context: lv,
              values: [
                first(
                  records(lv, "learn.Completion", {
                    parent: row,
                    where: (ack) => same(ack.lesson, lesson),
                  }),
                ) !== null,
              ],
            }),
            form({
              context: lv,
              operation: "learn.complete",
              arguments: { enrollment: row, lesson },
            }),
          ],
        }),
      ],
      children: [pagination({ context: c })],
    }),
  ]);
}

export async function coursesPage(c, bindings) {
  return renderPage(c, coursesPageDescriptor, () => [
    breadcrumbs({ context: c }),
    card({
      context: c,
      title: message("Course authoring", { nl: "Cursussen beheren" }),
      children: [
        form({
          context: c,
          operation: "learn.Course.create",
          children: [
            input({ context: c, field: "title" }),
            radio({ context: c, field: "audience" }),
            checkbox({ context: c, field: "required" }),
          ],
        }),
        list({
          context: c,
          model: "learn.Course",
          alias: "course",
          where: (course) =>
            c.preferences.learn.location === null ||
            course.locations.includes(c.preferences.learn.location),
          filter: ["audience", "required"],
          defaults: { audience: c.preferences.learn.audience },
          search: ["title"],
          display: "split",
          empty: message("No courses yet", { nl: "Nog geen cursussen" }),
          renderRow: (row, view) => [
            badge({ context: view, value: row.audience }),
            edit({ context: view, operation: "learn.Course.update", record: row }),
            tabs({
              context: view,
              children: [
                tab({
                  context: view,
                  caption: message("Ordered draft lessons", { nl: "Geordende conceptlessen" }),
                  children: [
                    form({
                      context: view,
                      operation: "learn.DraftLesson.create",
                      arguments: { parent: row },
                      children: [
                        input({ context: view, field: "title" }),
                        textarea({ context: view, field: "content" }),
                        input({ context: view, field: "position" }),
                      ],
                    }),
                    list({
                      context: view,
                      model: "learn.DraftLesson",
                      parent: row,
                      order: ["position"],
                      empty: message("No draft lessons yet", { nl: "Nog geen conceptlessen" }),
                      renderRow: (draft, dv) => [
                        edit({ context: dv, operation: "learn.DraftLesson.update", record: draft }),
                        actions({ context: dv, operations: ["learn.DraftLesson.delete"], boundArgs: { record: draft } }),
                      ],
                      children: [pagination({ context: view })],
                    }),
                    action({ context: view, operation: "learn.publish", boundArgs: { course: row } }),
                  ],
                }),
                tab({
                  context: view,
                  caption: message("Published versions and enrollments", {
                    nl: "Gepubliceerde versies en inschrijvingen",
                  }),
                  children: [
                    list({
                      context: view,
                      model: "learn.Version",
                      parent: row,
                      empty: message("No published versions yet", { nl: "Nog geen gepubliceerde versies" }),
                      renderRow: (version, vv) => [
                        badge({ context: vv, value: version.audience }),
                        button({ context: vv, opens: "enroll" }),
                        modal({
                          context: vv,
                          caption: message("Enroll learner", { nl: "Deelnemer inschrijven" }),
                          id: "enroll",
                          children: [
                            slot({
                              context: vv,
                              name: "content",
                              children: [
                                form({
                                  context: vv,
                                  operation: "learn.enroll",
                                  arguments: { version },
                                  display: "inline",
                                  children: [
                                    calendar({ context: vv, field: "due" }),
                                  ],
                                }),
                              ],
                            }),
                          ],
                        }),
                        table({
                          context: vv,
                          model: "learn.Enrollment",
                          parent: version,
                          columns: ["account", "due", "active", "total", "progress"],
                          empty: message("No enrollments yet", { nl: "Nog geen inschrijvingen" }),
                          renderRow: (enrollment, ev) => [
                            progress({ context: ev, value: enrollment.progress, max: 100 }),
                            action({ context: ev, operation: "learn.withdraw", boundArgs: { enrollment } }),
                            table({
                              context: ev,
                              model: "learn.Completion",
                              parent: enrollment,
                              columns: ["lesson", "author", "completed"],
                              order: ["completed"],
                              empty: message("No acknowledgments yet", { nl: "Nog geen bevestigingen" }),
                              children: [pagination({ context: ev })],
                            }),
                          ],
                          children: [pagination({ context: vv })],
                        }),
                      ],
                      children: [pagination({ context: view })],
                    }),
                  ],
                }),
              ],
            }),
          ],
          children: [pagination({ context: c })],
        }),
      ],
    }),
  ]);
}
