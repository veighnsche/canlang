import {
  OperationOutcome,
  addDecimal,
  addDuration,
  addMoney,
  add_days,
  all,
  any,
  at,
  bounded,
  call,
  cancel,
  collect,
  compareDate,
  compareDecimal,
  compareInstant,
  compareMoney,
  compareValue,
  count,
  create,
  dates,
  date,
  datetime,
  delivery,
  divideDecimal,
  durationBetween,
  emit,
  equalMoney,
  equalValue,
  first,
  flatten,
  format,
  group,
  hasRole,
  int64,
  local_date,
  local_instant,
  max,
  min,
  money,
  multiplyDecimal,
  multiplyMoney,
  overlaps,
  records,
  require as check,
  same,
  schedule,
  send,
  set,
  subtractDecimal,
  subtractDuration,
  subtractMoney,
  sum,
  weekday,
} from "@canlang/stdlib";
import {
  action,
  actions,
  calendar,
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
import { BillingProfile, Customer, has_location_role, owns } from "./customer.mjs";
import { Charge, DocumentLine, Settlement, SaleMilestone } from "./deployment.billing.mjs";
import { AllowanceOutcome, BenefitInterval, Entitlement } from "./deployment.membership.mjs";
import { can_work } from "./employee.mjs";
import { AcceptedOffer, QuoteDocument, QuoteOffer, quote_intervals_valid } from "./propose.mjs";
import {
  ClosedDate,
  DateHours,
  Location,
  LocationPolicy,
  WeeklyHours,
  catalog_owner,
  is_open,
  policy_open,
} from "./rent_catalog.mjs";
import { Capture, latest_capture } from "./sales_attribution.mjs";
import { Checkpoint, Contribution, ReportBatch } from "./report.mjs";

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

const R = "rent_reservations";

const F = "rent_fulfillment";

export async function can_read_booking_details(c, booking) {
  return (hasRole(c, "rent_reservations.reservation_manager") && await can_work(c, c.actor, booking.parent.location))
    || (hasRole(c, "authenticated") && same(booking.account, c.actor))
    || (hasRole(c, "rent_reservations.billing") && await can_work(c, c.actor, booking.parent.location));
}

async function may_reserve(c, account, customer, resource) {
  return customer.active && customer.locations.some(location => same(location, resource.location))
    && (await owns(c, account, customer)
      || await has_location_role(c, account, customer, "booker", resource.location)
      || await has_location_role(c, account, customer, "administrator", resource.location));
}

async function may_move(c, booking) {
  return await may_reserve(c, booking.account, booking.customer, booking.parent)
    || (booking.customer.active && booking.customer.locations.some(location => same(location, booking.parent.location))
      && hasRole(c, "rent_reservations.reservation_manager") && await can_work(c, c.actor, booking.parent.location));
}

function commercial(c, booking, sale, location, product, amount, purchased, phase, at) {
  return {
    source: booking.source,
    revision: sale.revision,
    customer: booking.customer.id,
    account: booking.account,
    location: location.id,
    product,
    amount,
    purchased_at: purchased,
    occurred: at,
    milestone: phase,
    attribution: booking.attribution,
    exclusive_program: booking.exclusive_program,
    attributed_at: booking.attributed_at,
    attribution_window: booking.attribution_window,
  };
}

function busy(c, b) {
  return (
    ["confirmed", "occupied"].includes(b.status) ||
    (["held", "pending"].includes(b.status) && compareInstant(c.now, b.expires) < 0) ||
    (b.checked_in !== null &&
      (b.checked_out === null ||
        compareInstant(c.now, addDuration(b.checked_out, b.departure_buffer)) < 0))
  );
}

function covers(c, b, point) {
  return (
    (!b.intervals.length &&
      compareInstant(b.reserved_from, point) <= 0 &&
      compareInstant(point, b.reserved_until) < 0) ||
    b.intervals.some(
      (interval) =>
        compareInstant(interval.from, point) <= 0 && compareInstant(point, interval.until) < 0,
    ) ||
    (b.checked_in !== null && b.checked_out === null && compareInstant(b.checked_in, point) <= 0) ||
    (b.checked_out !== null &&
      compareInstant(b.checked_out, point) <= 0 &&
      compareInstant(point, addDuration(b.checked_out, b.departure_buffer)) < 0)
  );
}

function movement_busy(c, movement) {
  return (
    movement.state === "committing" ||
    (["holding", "waiting_money"].includes(movement.state) &&
      compareInstant(c.now, movement.expires) < 0)
  );
}

function movement_covers(c, movement, point) {
  return (
    movement.intervals.some(
      (interval) =>
        compareInstant(subtractDuration(interval.from, movement.parent.arrival_buffer), point) <=
          0 &&
        compareInstant(point, addDuration(interval.until, movement.parent.departure_buffer)) < 0,
    ) && !(busy(c, movement.parent) && covers(c, movement.parent, point))
  );
}

function movement_request(c, movement) {
  const booking = movement.parent;
  return {
    source: movement.source,
    customer: booking.customer.id,
    account: booking.account,
    location: booking.parent.location.id,
    product: "workspace",
    intervals: movement.intervals,
    quantity: booking.quantity,
    unit: booking.benefit_unit,
    duration: booking.benefit_duration,
    rate: booking.benefit_rate ?? booking.rate,
    previous_source: booking.allowance_source ?? booking.source,
    restore_consumed: true,
  };
}

function quote_covers(c, hold, point) {
  return (
    (!hold.intervals.length &&
      compareInstant(hold.from, point) <= 0 &&
      compareInstant(point, hold.until) < 0) ||
    hold.intervals.some(
      (interval) =>
        compareInstant(interval.from, point) <= 0 && compareInstant(point, interval.until) < 0,
    )
  );
}

async function quote_available(c, resource, value, quantity) {
  if (
    !quote_intervals_valid(c, value.from, value.until, value.intervals) ||
    (resource.price_unit === "day" && !value.intervals.length)
  )
    return false;
  if (!value.intervals.length)
    return free(
      c,
      resource,
      subtractDuration(value.from, resource.buffer_before),
      addDuration(value.until, resource.buffer_after),
      quantity,
      null,
    );
  for (const interval of value.intervals) {
    if (resource.price_unit === "day") {
      let published = false;
      for await (const day of records(c, "rent_reservations.DayCalendar", { parent: resource }))
        if (
          !day.closed &&
          compareInstant(
            interval.from,
            local_instant(day.day, day.opens, resource.timezone, { fold: day.fold }),
          ) === 0 &&
          compareInstant(
            interval.until,
            local_instant(day.day, day.closes, resource.timezone, { fold: day.fold }),
          ) === 0
        )
          published = true;
      if (!published) return false;
    }
    if (
      !(await free(
        c,
        resource,
        subtractDuration(interval.from, resource.buffer_before),
        addDuration(interval.until, resource.buffer_after),
        quantity,
        null,
      ))
    )
      return false;
  }
  return true;
}

async function free_at(c, resource, point, quantity, skip, skip_venue = null) {
  return (
    int64(
      quantity +
        (await sum(
          records(c, "rent_reservations.Booking", {
            parent: resource,
            where: (b) => !same(b, skip) && busy(c, b) && covers(c, b, point),
          }),
          (b) => b.quantity,
        )) +
        (await sum(
          records(c, "rent_reservations.VenueReservation", {
            parent: resource,
            where: (venue) =>
              !same(venue, skip_venue) && venue_busy(c, venue) && venue_covers(c, venue, point),
          }),
          (venue) => venue.quantity,
        )) +
        (await sum(
          records(c, "rent_reservations.QuoteHold", {
            parent: resource,
            where: (hold) =>
              hold.active &&
              compareInstant(c.now, hold.expires) < 0 &&
              quote_covers(c, hold, point),
          }),
          (hold) => hold.quantity,
        )) +
        (await sum(
          records(c, "rent_reservations.Movement", {
            where: (movement) =>
              same(movement.parent.parent, resource) &&
              movement_busy(c, movement) &&
              movement_covers(c, movement, point),
          }),
          (movement) => movement.parent.quantity,
        )),
    ) <= resource.capacity
  );
}

async function free(c, resource, from, until, quantity, skip, skip_venue = null) {
  return (
    resource.active &&
    (await is_open(c, resource.location, from, until)) &&
    compareInstant(from, until) < 0 &&
    quantity <= resource.capacity &&
    (await any(
      records(c, "rent_reservations.Window", { parent: resource }),
      (w) => !w.closed && compareInstant(w.from, from) <= 0 && compareInstant(until, w.until) <= 0,
    )) &&
    !(await any(
      records(c, "rent_reservations.Window", { parent: resource }),
      (w) => w.closed && overlaps(from, until, w.from, w.until),
    )) &&
    !(await any(
      records(c, "rent_reservations.Downtime", { parent: resource }),
      (d) =>
        d.active &&
        compareInstant(d.from, until) < 0 &&
        (d.until === null || compareInstant(from, d.until) < 0),
    )) &&
    (await free_at(c, resource, from, quantity, skip, skip_venue)) &&
    (await all(
      records(c, "rent_reservations.Booking", { parent: resource }),
      async (b) =>
        same(b, skip) ||
        !busy(c, b) ||
        ((compareInstant(b.reserved_from, from) < 0 ||
          compareInstant(until, b.reserved_from) <= 0 ||
          (await free_at(c, resource, b.reserved_from, quantity, skip, skip_venue))) &&
          (await all(
            b.intervals,
            async (interval) =>
              compareInstant(interval.from, from) < 0 ||
              compareInstant(until, interval.from) <= 0 ||
              (await free_at(c, resource, interval.from, quantity, skip, skip_venue)),
          ))),
    )) &&
    (await all(
      records(c, "rent_reservations.VenueReservation", { parent: resource }),
      async (venue) =>
        same(venue, skip_venue) ||
        !venue_busy(c, venue) ||
        compareInstant(venue.from, from) < 0 ||
        compareInstant(until, venue.from) <= 0 ||
        (await free_at(c, resource, venue.from, quantity, skip, skip_venue)),
    )) &&
    (await all(
      records(c, "rent_reservations.QuoteHold", { parent: resource }),
      async (hold) =>
        !hold.active ||
        compareInstant(hold.expires, c.now) <= 0 ||
        (!hold.intervals.length &&
          (compareInstant(hold.from, from) < 0 ||
            compareInstant(until, hold.from) <= 0 ||
            (await free_at(c, resource, hold.from, quantity, skip, skip_venue)))) ||
        (hold.intervals.length > 0 &&
          (await all(
            hold.intervals,
            async (interval) =>
              compareInstant(interval.from, from) < 0 ||
              compareInstant(until, interval.from) <= 0 ||
              (await free_at(c, resource, interval.from, quantity, skip, skip_venue)),
          ))),
    )) &&
    (await all(
      records(c, "rent_reservations.Movement"),
      async (movement) =>
        !same(movement.parent.parent, resource) ||
        !movement_busy(c, movement) ||
        (await all(
          movement.intervals,
          async (interval) =>
            compareInstant(subtractDuration(interval.from, movement.parent.arrival_buffer), from) <
              0 ||
            compareInstant(
              until,
              subtractDuration(interval.from, movement.parent.arrival_buffer),
            ) <= 0 ||
            (await free_at(
              c,
              resource,
              subtractDuration(interval.from, movement.parent.arrival_buffer),
              quantity,
              skip,
              skip_venue,
            )),
        )),
    ))
  );
}

function venue_busy(c, venue) {
  return (
    ["held", "staged", "confirmed"].includes(venue.status) &&
    (venue.status === "confirmed" || compareInstant(c.now, venue.expires) < 0)
  );
}

function venue_covers(c, venue, point) {
  return (
    compareInstant(venue.from, point) <= 0 &&
    compareInstant(point, venue.until) < 0 &&
    !(
      venue.previous !== null &&
      venue_busy(c, venue.previous) &&
      compareInstant(venue.previous.from, point) <= 0 &&
      compareInstant(point, venue.previous.until) < 0
    )
  );
}

async function credit_allowed(c, customer, resource) {
  return (
    customer.active &&
    (await any(
      records(c, "customer.BillingProfile", { parent: customer }),
      (profile) =>
        profile.on_account &&
        profile.approved_locations.some((location) => same(location, resource.location)),
    ))
  );
}

async function bookable(c, booking) {
  return (
    (!booking.intervals.length &&
      (await free(
        c,
        booking.parent,
        booking.reserved_from,
        booking.reserved_until,
        booking.quantity,
        booking,
      ))) ||
    (booking.intervals.length > 0 &&
      (await all(booking.intervals, (interval) =>
        free(c, booking.parent, interval.from, interval.until, booking.quantity, booking),
      )))
  );
}

async function credit_baseline(c, charge_source, current) {
  return max([
    current,
    ...(
      await collect(
        records(c, "rent_reservations.MovementCredit", {
          where: (credit) => credit.charge_source === charge_source && credit.state !== "failed",
        }),
      )
    ).map((credit) => addMoney(credit.baseline, credit.amount)),
  ]);
}

async function financial_cover(c, booking) {
  return (
    compareMoney(
      addMoney(
        subtractMoney(
          booking.collected ?? money(0n, booking.total.currency),
          booking.refunded ?? money(0n, booking.total.currency),
        ),
        await sum(
          records(c, "rent_reservations.Adjustment", {
            parent: booking,
            where: (adjustment) => adjustment.movement !== null,
          }),
          (adjustment) =>
            subtractMoney(
              adjustment.collected ?? money(0n, booking.total.currency),
              adjustment.refunded ?? money(0n, booking.total.currency),
            ),
          booking.total.currency,
        ),
      ),
      booking.service_due ?? booking.monetary_due ?? booking.total,
    ) >= 0
  );
}

function benefit_request(c, booking) {
  return {
    source: booking.source,
    customer: booking.customer.id,
    account: booking.account,
    location: booking.parent.location.id,
    product: "workspace",
    intervals: booking.benefit_intervals,
    quantity: booking.quantity,
    unit: booking.benefit_unit,
    duration: booking.benefit_duration,
    rate: booking.benefit_rate ?? booking.rate,
    previous_source: null,
    restore_consumed: false,
  };
}

function charge_request(c, booking, base, discount, tax) {
  return {
    source: booking.source,
    customer: booking.customer.id,
    location: booking.parent.location.id,
    description: booking.parent.name,
    amount: addMoney(subtractMoney(base, discount), tax),
    due: local_date(booking.from, booking.parent.timezone),
    terms: booking.terms,
    items: [
      {
        title: booking.parent.name,
        quantity: "1",
        price: base,
        tax,
        discount,
        unit: "reservation",
        from: booking.from,
        until: booking.until,
        location: booking.parent.location.name,
        reference: booking.source,
      },
    ],
  };
}

function next_boundary(c, points, left, until) {
  return points.filter((point) => compareInstant(left, point) < 0).sort(compareInstant)[0] ?? until;
}

async function resource_evidence(c, resource) {
  return {
    active: resource.active,
    capacity: resource.capacity,
    pooled: resource.pooled,
    timezone: resource.timezone,
    windows: (await collect(records(c, "rent_reservations.Window", { parent: resource }))).map(
      (window) => ({ from: window.from, until: window.until, closed: window.closed }),
    ),
    downtime: (await collect(records(c, "rent_reservations.Downtime", { parent: resource }))).map(
      (downtime) => ({ from: downtime.from, until: downtime.until, active: downtime.active }),
    ),
    bookings: (await collect(records(c, "rent_reservations.Booking", { parent: resource }))).map(
      (booking) => ({
        from: booking.from,
        until: booking.until,
        intervals: booking.intervals,
        quantity: booking.quantity,
        status: booking.status,
        checked_in: booking.checked_in,
        checked_out: booking.checked_out,
        arrival_buffer: booking.arrival_buffer,
        departure_buffer: booking.departure_buffer,
      }),
    ),
    venues: (
      await collect(records(c, "rent_reservations.VenueReservation", { parent: resource }))
    ).map((venue) => ({
      from: venue.from,
      until: venue.until,
      quantity: venue.quantity,
      status: venue.status,
    })),
  };
}

function saved_service(c, booking, point) {
  return (
    (!booking.intervals.length &&
      compareInstant(booking.from, point) <= 0 &&
      compareInstant(point, booking.until) < 0) ||
    booking.intervals.some(
      (interval) =>
        compareInstant(addDuration(interval.from, booking.arrival_buffer), point) <= 0 &&
        compareInstant(point, subtractDuration(interval.until, booking.departure_buffer)) < 0,
    )
  );
}

async function saved_saleable(c, policy, opening, left, right) {
  return (
    policy.value.active &&
    (await policy_open(c, opening, left, right)) &&
    (await any(
      policy.value.windows,
      (window) =>
        !window.closed &&
        compareInstant(window.from, left) <= 0 &&
        compareInstant(right, window.until) <= 0,
    )) &&
    !(await any(
      policy.value.windows,
      (window) => window.closed && overlaps(left, right, window.from, window.until),
    )) &&
    !(await any(
      policy.value.downtime,
      (downtime) =>
        downtime.active &&
        compareInstant(downtime.from, right) < 0 &&
        (downtime.until === null || compareInstant(left, downtime.until) < 0),
    ))
  );
}

async function saved_rows(c, resource, points, until) {
  const rows = [];
  for (const left of points)
    if (compareInstant(left, until) < 0) {
      const policy = await first(
        records(c, "rent_reservations.ResourcePolicy", {
          parent: resource,
          where: (candidate) => compareInstant(candidate.effective, left) <= 0,
          order: ["-sequence"],
        }),
      );
      const opening = await first(
        records(c, "rent_catalog.LocationPolicy", {
          parent: resource.location,
          where: (candidate) => compareInstant(candidate.effective, left) <= 0,
          order: ["-sequence"],
        }),
      );
      if (policy === null || opening === null) continue;
      const right = next_boundary(c, points, left, until),
        minutes = divideDecimal(durationBetween(right, left), 60000n),
        saleable = await saved_saleable(c, policy, opening, left, right),
        common = {
          source: resource.id,
          revision: policy.sequence,
          location: resource.location.id,
          from: left,
          until: right,
          unit: policy.value.pooled ? "seat-minute" : "room-minute",
        };
      rows.push(
        {
          ...common,
          metric: "booked_minutes",
          quantity: addDecimal(
            multiplyDecimal(
              minutes,
              await sum(
                policy.value.bookings.filter(
                  (booking) =>
                    ["confirmed", "occupied", "completed"].includes(booking.status) &&
                    saved_service(c, booking, left),
                ),
                (booking) => booking.quantity,
              ),
            ),
            multiplyDecimal(
              minutes,
              await sum(
                policy.value.venues.filter(
                  (venue) =>
                    venue.status === "confirmed" &&
                    compareInstant(venue.from, left) <= 0 &&
                    compareInstant(left, venue.until) < 0,
                ),
                (venue) => venue.quantity,
              ),
            ),
          ),
        },
        {
          ...common,
          metric: "occupied_minutes",
          quantity: multiplyDecimal(
            minutes,
            await sum(
              policy.value.bookings.filter(
                (booking) =>
                  booking.checked_in !== null &&
                  compareInstant(booking.checked_in, left) <= 0 &&
                  compareInstant(left, booking.checked_out ?? c.now) < 0,
              ),
              (booking) => booking.quantity,
            ),
          ),
          provisional: await any(
            policy.value.bookings,
            (booking) => booking.checked_in !== null && booking.checked_out === null,
          ),
        },
        {
          ...common,
          metric: "saleable_minutes",
          quantity: multiplyDecimal(minutes, saleable ? policy.value.capacity : 0n),
        },
        {
          ...common,
          metric: "excluded_minutes",
          quantity: multiplyDecimal(minutes, saleable ? 0n : policy.value.capacity),
        },
      );
    }
  return rows;
}

const sourceLabel = message("Source reference", { nl: "Bronreferentie" });

const accountLabel = message("User account", { nl: "Gebruikersaccount" });

const fromLabel = message("From", { nl: "Van" });

const untilLabel = message("Until", { nl: "Tot" });

const termsLabel = message("Commercial terms", { nl: "Commerciële voorwaarden" });

const pendingLabel = message("Pending", { nl: "In afwachting" });

const useAllowanceLabel = message("Use membership allowance", {
  nl: "Lidmaatschapstegoed gebruiken",
});

const policyTitle = message("Commercial policy and access", {
  nl: "Commerciële voorwaarden en toegang",
});

const resourceCreate = [
  "location",
  "name",
  "pooled",
  "capacity",
  "timezone",
  "currency",
  "hourly",
  "daily",
  "price_unit",
  "tax_rate",
  "discount_rate",
  "cancellation_fee",
  "terms",
  "refund_notice",
  "accessibility",
  "party_limit",
  "kind",
  "hold_for",
];

const resourceUpdate = [
  "name",
  "active",
  "hourly",
  "daily",
  "price_unit",
  "tax_rate",
  "discount_rate",
  "cancellation_fee",
  "increment",
  "minimum",
  "terms",
  "refund_notice",
  "buffer_before",
  "buffer_after",
  "amenities",
  "accessibility",
  "party_limit",
  "kind",
  "hold_for",
];

const windowFields = ["from", "until", "closed", "reason"];

const publicResourceFields = [
  "location",
  "name",
  "pooled",
  "capacity",
  "active",
  "timezone",
  "currency",
  "hourly",
  "increment",
  "minimum",
  "terms",
  "refund_notice",
  "amenities",
  "accessibility",
  "party_limit",
  "kind",
  "hold_for",
  "daily",
  "price_unit",
  "tax_rate",
  "discount_rate",
  "cancellation_fee",
];

// Historical ranges before the first owning policy snapshots are explicitly partial.
// No migration backfill or prebaseline history is fabricated.

export const reservation_manager = "rent_reservations.reservation_manager";
export const reception = "rent_reservations.reception";
export const Resource = "rent_reservations.Resource";
export const LegacyBooking = "rent_reservations.LegacyBooking";
export const retain_legacy = "rent_reservations.retain_legacy";
export const link_legacy = "rent_reservations.link_legacy";
export const Booking = "rent_reservations.Booking";
export const Notice = "rent_reservations.Notice";
export const Movement = "rent_reservations.Movement";
export const resource_report = "rent_reservations.resource_report";
export const move = "rent_reservations.move";
export const move_days = "rent_reservations.move_days";
export const move_membership = "rent_reservations.move_membership";
export const move_membership_days = "rent_reservations.move_membership_days";
export const abandon_movement = "rent_reservations.abandon_movement";
export const retry_movement_cleanup = "rent_reservations.retry_movement_cleanup";
export const reconcile_movement = "rent_reservations.reconcile_movement";
export const prepare = "rent_reservations.prepare";
export const arrive = "rent_reservations.arrive";
export const depart = "rent_reservations.depart";
export const cancel_booking = "rent_reservations.cancel_booking";
export const assign_desk = "rent_reservations.assign_desk";
export const fulfill_free = "rent_reservations.fulfill_free";
export const confirm_account = "rent_reservations.confirm_account";
export const no_show = "rent_reservations.no_show";
export const extend = "rent_reservations.extend";
export const resend_notice = "rent_reservations.resend_notice";
export const reconcile_allowance = "rent_reservations.reconcile_allowance";
export const reconcile_booking = "rent_reservations.reconcile_booking";

const bookingHistoryPageDescriptor = {
  owner:"rent_reservations",path:"/workspace/history",title:message("Historical booking evidence", {nl:"Historisch reserveringsbewijs"}),
  description:message("Read retained booking evidence under current staff or explicitly mapped account access.", {nl:"Lees bewaard reserveringsbewijs met huidige medewerkersrechten of toegang voor een uitdrukkelijk gekoppeld account."}),
  admit:async(c,routeBindings={})=>{check(hasRole(c,"authenticated"),"forbidden");return {};},render:bookingHistoryPage,
};

const workspaceCatalogPageDescriptor = {
  owner: "rent_catalog_ui",
  path: "/workspace/catalog",
  order: 6n,
  title: message("Workspace catalog", { nl: "Werkplekcatalogus" }),
  description: message("Author location descriptions and arrival information.", {
    nl: "Schrijf locatiebeschrijvingen en aankomstinformatie.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, catalog_owner), "forbidden");
    return {};
  },
  render: workspaceCatalogPage,
};

const financeReviewPageDescriptor = {
  owner: R,
  path: "/workspace/refund-review",
  order: 8n,
  title: message("Booking finance exceptions", { nl: "Financiële reserveringsuitzonderingen" }),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "rent_reservations.billing"), "forbidden");
    return {};
  },
  render: financeReviewPage,
};

const resourceCatalogPageDescriptor = {
  owner: R,
  path: "/workspace/resources",
  order: 7n,
  title: message("Resource catalog", { nl: "Voorzieningencatalogus" }),
  description: message(
    "Author published resource rates and commercial policy under catalog authority.",
    {
      nl: "Stel gepubliceerde tarieven en commerciële voorwaarden op onder catalogusbevoegdheid.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, catalog_owner), "forbidden");
    return {};
  },
  render: resourceCatalogPage,
};

const workspacePageDescriptor = {
  owner: R,
  path: "/workspace",
  order: 1n,
  title: message("Available workspace", { nl: "Beschikbare werkplekken" }),
  description: message(
    "Discover space and enter local-time intervals before creating a hold.",
    { nl: "Vind ruimte en voer tijdvakken in lokale tijd in voordat je tijdelijk reserveert." },
  ),
  admit: async (c, routeBindings = {}) => {
    check(c.team != null, "forbidden");
    return {};
  },
  render: workspacePage,
};

const reservationsPageDescriptor = {
  owner: R,
  path: "/workspace/reservations",
  order: 5n,
  title: message("Reservations", { nl: "Reserveringen" }),
  description: message("Manage availability, current holds and affected downtime.", {
    nl: "Beheer beschikbaarheid, huidige tijdelijke reserveringen en getroffen uitval.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "rent_reservations.reservation_manager"), "forbidden");
    return {};
  },
  render: reservationsPage,
};

const myBookingsPageDescriptor = {
  owner: "rent_fulfillment",
  path: "/workspace/my-bookings",
  order: 2n,
  title: message("My bookings", { nl: "Mijn reserveringen" }),
  description: message(
    "Show fulfillment, money and actual occupancy as separate recorded outcomes.",
    {
      nl: "Toon uitvoering, betalingen en werkelijk gebruik als afzonderlijk vastgelegde resultaten.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    check(c.team != null, "forbidden");
    check(hasRole(c, "authenticated"), "forbidden");
    return {};
  },
  render: myBookingsPage,
};

const arrivalsPageDescriptor = {
  owner: "rent_fulfillment",
  path: "/workspace/arrivals",
  order: 3n,
  title: message("Workspace arrivals", { nl: "Werkplekaankomsten" }),
  description: message("Resolve physical arrivals, departures and late-payment exceptions.", {
    nl: "Los werkelijke aankomsten, vertrekken en uitzonderingen bij late betaling op.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "rent_reservations.reception"), "forbidden");
    return {};
  },
  render: arrivalsPage,
};

const occupancyPageDescriptor = {
  owner: "rent_reporting",
  path: "/workspace/occupancy",
  order: 4n,
  title: message("Local occupancy", { nl: "Lokale bezetting" }),
  description: message(
    "Keep booked intervals and actual occupancy visible as distinct evidence.",
    {
      nl: "Houd gereserveerde tijdvakken en werkelijke bezetting zichtbaar als afzonderlijk bewijs.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    check(c.team != null, "forbidden");
    check(hasRole(c, "authenticated"), "forbidden");
    return {};
  },
  render: occupancyPage,
};

export const appDefinition = {
  id: "CanRent",
  uses: [
    "rent_catalog",
    "rent_catalog_ui",
    "rent_reservations",
    "rent_fulfillment",
    "rent_reporting",
  ],
  description: message(
    "Be the workspace operator's authoritative booking app for coworking desks, day offices, meeting rooms, and rentable event spaces.",
    {
      nl: "Wees de gezaghebbende reserveringsapp van de werkplekexploitant voor coworkingbureaus, dagkantoren, vergaderruimtes en verhuurbare evenementruimtes.",
    },
  ),
  compositions: {
    Workspace: {
      uses: ["CanRent", "CanMember", "CanReport"],
      description: message(
        "Reserve workspace and manage paid membership benefits with scoped operational reports.",
        {
          nl: "Reserveer werkplekken en beheer betaalde lidmaatschapsvoordelen met afgebakende operationele rapporten.",
        },
      ),
    },
  },
  packages: {
    rent_catalog_ui: {
      description: message(
        "Maintain the published workspace catalog under the canonical catalog owner's grant.",
        {
          nl: "Onderhoud de gepubliceerde werkplekcatalogus onder de bevoegdheid van de canonieke catalogusbeheerder.",
        },
      ),
    },
    rent_reservations: {
      label: message("Workspace reservations", { nl: "Werkplekreserveringen" }),
      description: message(
        "Coordinate capacity, buffers, holds and downtime at each resource's single owner.",
        {
          nl: "Coördineer capaciteit, buffers, tijdelijke reserveringen en uitval bij de enige eigenaar van elke voorziening.",
        },
      ),
      roles: {
        reservation_manager: {
          exported: true,
          label: message("Reservation manager", { nl: "Reserveringsbeheerder" }),
          id: "rent_reservations.reservation_manager",
        },
        reception: {
          exported: true,
          label: message("Reception", { nl: "Receptie" }),
          id: "rent_reservations.reception",
        },
        billing: {
          label: message("Billing", { nl: "Facturatie" }),
          id: "rent_reservations.billing",
        },
      },
    },
    rent_fulfillment: {
      label: message("Workspace fulfillment", { nl: "Werkplekuitvoering" }),
      description: message(
        "Fulfill received payments and allowances without treating provider requests as success.",
        {
          nl: "Verwerk ontvangen betalingen en tegoeden zonder provideraanvragen als succes te behandelen.",
        },
      ),
    },
    rent_reporting: {
      label: message("Workspace occupancy", { nl: "Werkplekbezetting" }),
      description: message(
        "Read the resource owner's local booking and occupancy records under existing grants.",
        {
          nl: "Lees lokale reserverings- en bezettingsgegevens van de voorzieningseigenaar met de bestaande bevoegdheden.",
        },
      ),
    },
  },
  bindings: {
    "rent_reservations.Mail": { capability: "std.EmailV1", from: "deployment.mail" },
    "rent_reservations.Billing": { capability: "invoice.BillingV1", from: "deployment.billing" },
    "rent_reservations.Membership": {
      capability: "member_terms.MembershipV1",
      from: "deployment.membership",
    },
  },
  models: {
    "rent_reservations.LegacyBooking": {label:message("Historical booking", {nl:"Historische reservering"}),
      exported:true,unique:[{fields:["source","external_id"]}],locks:["LegacyBooking.lock.1"],invariants:["LegacyBooking.invariant.1"],
      readGrants:[{rule:"LegacyBooking.read.1"},{rule:"LegacyBooking.read.2",fields:["source","external_id","location","facts","customer","resource"]}],
      fields:{source:{type:"text",trim:true,min:1n,label:message("Source system", {nl:"Bronsysteem"})},external_id:{type:"text",min:1n,label:message("Original record key", {nl:"Oorspronkelijke recordsleutel"})},location:{type:Location,label:message("Current location scope", {nl:"Huidig locatiebereik"})},facts:{type:"rent_reservations.LegacyBookingFacts",label:message("Original booking facts", {nl:"Oorspronkelijke reserveringsgegevens"})},
        source_evidence:{type:"file",label:message("Original source artifact", {nl:"Oorspronkelijk bronbestand"})},attestation:{type:"text",trim:true,min:1n,label:message("Intake attestation", {nl:"Verklaring bij invoer"})},customer:{type:Customer,nullable:true,label:message("Current customer", {nl:"Huidige klant"})},resource:{type:Resource,nullable:true,label:message("Current resource", {nl:"Huidige voorziening"})},account:{type:"user",nullable:true,label:message("Current account", {nl:"Huidig account"})},mapping_reason:{type:"text",nullable:true,label:message("Review reason", {nl:"Reden voor beoordeling"})},imported_by:{type:"user",server:"actor",label:message("Imported by", {nl:"Ingevoerd door"})},imported_at:{type:"datetime",server:"now",label:message("Imported at", {nl:"Ingevoerd op"})}},
    },
    "rent_reservations.CommercialSale": {
      parent: "rent_reservations.Booking",
      unique: [{ fields: ["parent"] }],
      readGrants: [],
      fields: {
        phase: { type: "invoice.SaleMilestone.milestone", nullable: true, default: null },
        revision: { type: "int", default: 0n, min: 0n },
      },
    },
    "rent_reservations.DowntimeFence": {
      parent: "rent_reservations.Resource",
      readGrants: [{ rule: "DowntimeFence.read.1" }],
      fields: { source: { type: "text", unique: true }, evidence: { type: "text" } },
    },
    "rent_reservations.MovementCredit": {
      parent: "rent_reservations.Movement",
      label: message("Movement credit", { nl: "Verplaatsingstegoed" }),
      readGrants: [{ rule: "MovementCredit.read.1" }, { rule: "MovementCredit.read.2" }],
      fields: {
        charge_source: { type: "text" },
        amount: { type: "money" },
        baseline: { type: "money" },
        delivery: { type: "text", unique: true },
        state: {
          type: "enum",
          cases: ["pending", "paid", "failed", "unknown", "review"],
          default: "pending",
          label: {
            text: message("State", { nl: "Status" }),
            values: {
              pending: message("Pending", { nl: "In behandeling" }),
              paid: message("Paid", { nl: "Betaald" }),
              failed: message("Failed", { nl: "Mislukt" }),
              unknown: message("Unknown", { nl: "Onbekend" }),
              review: message("Review required", { nl: "Beoordeling nodig" }),
            },
          },
        },
        reason: { type: "text" },
      },
    },
    "rent_reservations.Notice": {
      exported: true,
      parent: "rent_reservations.Booking",
      label: message("Booking correspondence", { nl: "Reserveringscorrespondentie" }),
      readGrants: [
        {
          rule: "Notice.read.1",
          fields: [
            "parent",
            "kind",
            "revision",
            "subject",
            "body",
            "delivery.id",
            "delivery.status",
            "state",
            "created_by",
            "created",
            "updated_by",
            "updated",
            "archived_at",
          ],
        },
        {
          rule: "Notice.read.2",
          fields: [
            "parent",
            "kind",
            "revision",
            "subject",
            "body",
            "delivery.id",
            "delivery.status",
            "state",
            "created_by",
            "created",
            "updated_by",
            "updated",
            "archived_at",
          ],
        },
      ],
      fields: {
        kind: {
          type: "enum",
          cases: ["confirmation", "reminder", "cancellation"],
          label: {
            text: message("Kind", { nl: "Soort" }),
            values: {
              confirmation: message("Confirmation", { nl: "Bevestiging" }),
              reminder: message("Reminder", { nl: "Herinnering" }),
              cancellation: message("Cancellation", { nl: "Annulering" }),
            },
          },
        },
        revision: { type: "int" },
        subject: { type: "text" },
        body: { type: "text" },
        delivery: { type: "delivery", operation: "rent_reservations.Mail.send" },
      },
      derived: {
        state: {
          type: "std.DeliveryResult.status",
          handler: "Notice.state",
          label: {
            text: message("State", { nl: "Status" }),
            values: {
              pending: message("Pending", { nl: "In behandeling" }),
              succeeded: message("Succeeded", { nl: "Geslaagd" }),
              failed: message("Failed", { nl: "Mislukt" }),
              unknown: message("Unknown", { nl: "Onbekend" }),
              skipped: message("Skipped", { nl: "Overgeslagen" }),
            },
          },
        },
      },
    },
    "rent_reservations.Movement": {
      parent: "rent_reservations.Booking",
      label: message("Replacement workspace hold", { nl: "Vervangende werkplekreservering" }),
      exported: true,
      readGrants: [
        { rule: "Movement.read.1" },
        { rule: "Movement.read.2" },
        { rule: "Movement.read.3" },
      ],
      invariants: ["Movement.require.1"],
      fields: {
        source: { type: "text", unique: true },
        intervals: { type: BenefitInterval, array: true, requiredArray: true },
        expires: { type: "datetime" },
        state: {
          type: "enum",
          cases: [
            "holding",
            "waiting_money",
            "committing",
            "adopted",
            "cancelling",
            "cancelled",
            "review",
          ],
          default: "holding",
          label: {
            text: message("State", { nl: "Status" }),
            values: {
              holding: message("Holding candidate", { nl: "Kandidaat gereserveerd" }),
              waiting_money: message("Awaiting balance", { nl: "Wacht op saldo" }),
              committing: message("Committing replacement", { nl: "Vervanging vastleggen" }),
              adopted: message("Replacement adopted", { nl: "Vervanging overgenomen" }),
              cancelling: message("Cleanup pending", { nl: "Opruimen in behandeling" }),
              cancelled: message("Cancelled", { nl: "Geannuleerd" }),
              review: message("Review required", { nl: "Beoordeling nodig" }),
            },
          },
        },
        extra_due: { type: "money", nullable: true, default: null },
        extra_paid: { type: "bool", default: false },
        extra_delivery: { type: "text", nullable: true, default: null },
        extra_revision: { type: "int", default: 0n },
        credit_due: { type: "money", nullable: true, default: null },
        release_restore: { type: "bool", default: false },
        reserve_delivery: { type: "text", nullable: true, default: null },
        commit_delivery: { type: "text", nullable: true, default: null },
        release_delivery: { type: "text", nullable: true, default: null },
        reconcile_delivery: { type: "text", nullable: true, default: null },
        outcome: { type: AllowanceOutcome, nullable: true, default: null },
      },
    },
    "rent_reservations.VenueFence": {
      parent: "rent_reservations.Resource",
      fields: { source: { type: "text", unique: true }, reason: { type: "text" } },
      label: message("Cancelled venue request", { nl: "Geannuleerde ruimteaanvraag" }),
      readGrants: [{ rule: "VenueFence.read.1" }],
      invariants: [],
    },
    "rent_reservations.ReservationFence": {
      parent: "rent_reservations.Resource",
      unique: [{ fields: ["source", "revision"] }],
      fields: { source: { type: "text" }, revision: { type: "int" }, reason: { type: "text" }, offer: { type: AcceptedOffer, nullable: true } },
      locks: ["ReservationFence.lock.1"],
      label: message("Closed quote revision", { nl: "Afgesloten offerteversie" }),
      readGrants: [{ rule: "ReservationFence.read.1" }],
      invariants: [],
    },
    "rent_reservations.VenueReservation": {
      parent: "rent_reservations.Resource",
      label: message("Appointment venue reservation", { nl: "Afspraakruimtereservering" }),
      fields: {
        source: { type: "text", unique: true },
        request_revision: { type: "int", default: 1n },
        customer: { type: "text" },
        account: { type: "user" },
        from: { type: "datetime" },
        until: { type: "datetime" },
        quantity: { type: "int", min: 1n },
        expires: { type: "datetime" },
        status: {
          type: "enum",
          cases: ["held", "staged", "confirmed", "released", "expired"],
          default: "held",
          label: {
            text: message("Status", { nl: "Status" }),
            values: {
              held: message("Held", { nl: "Tijdelijk gereserveerd" }),
              staged: message("Staged", { nl: "Voorbereid" }),
              confirmed: message("Confirmed", { nl: "Bevestigd" }),
              released: message("Released", { nl: "Vrijgegeven" }),
              expired: message("Expired", { nl: "Verlopen" }),
            },
          },
        },
        previous: { type: "rent_reservations.VenueReservation", nullable: true, default: null },
        reason: { type: "text", nullable: true, default: null },
      },
      readGrants: [
        { rule: "VenueReservation.read.1" },
        { rule: "VenueReservation.read.2" },
        { rule: "VenueReservation.read.3" },
      ],
      invariants: ["VenueReservation.require.1"],
    },
    "rent_reservations.QuoteHold": {
      parent: "rent_reservations.Resource",
      label: message("Quoted capacity hold", { nl: "Offertecapaciteitsreservering" }),
      fields: {
        source: { type: "text", unique: true },
        revision: { type: "int" },
        offer: { type: QuoteOffer },
        quantity: { type: "int", min: 1n },
        from: { type: "datetime" },
        until: { type: "datetime" },
        intervals: { type: "rent_reservations.BookingInterval", array: true },
        expires: { type: "datetime" },
        active: { type: "bool", default: true },
        booking: { type: "rent_reservations.Booking", nullable: true, default: null },
      },
      readGrants: [{ rule: "QuoteHold.read.1" }],
      invariants: ["QuoteHold.require.1"],
    },
    "rent_reservations.Resource": {
      exported: true,
      ownership: "team",
      readGrants: [
        {
          rule: "Resource.read.1",
          fields: [
            "location",
            "name",
            "pooled",
            "capacity",
            "active",
            "timezone",
            "currency",
            "hourly",
            "increment",
            "minimum",
            "terms",
            "refund_notice",
            "amenities",
            "accessibility",
            "party_limit",
            "kind",
            "hold_for",
            "daily",
            "price_unit",
            "tax_rate",
            "discount_rate",
            "cancellation_fee",
          ],
        },
        { rule: "Resource.read.2" },
        { rule: "Resource.read.3" },
      ],
      label: message("Workspace resource", { nl: "Werkplekvoorziening" }),
      invariants: ["Resource.require.1", "Resource.require.2"],
      fields: {
        location: { type: Location },
        name: { type: "text", trim: true, min: 1n },
        pooled: {
          type: "bool",
          default: false,
          label: message("Shared capacity", { nl: "Gedeelde capaciteit" }),
        },
        capacity: {
          type: "int",
          default: 1n,
          min: 1n,
          label: message("Capacity", { nl: "Capaciteit" }),
        },
        party_limit: {
          type: "int",
          default: 1n,
          min: 1n,
          label: message("Attendee limit", { nl: "Deelnemerslimiet" }),
        },
        kind: {
          type: "enum",
          cases: ["desk", "office", "meeting", "event_space"],
          default: "meeting",
          label: {
            text: message("Resource type", { nl: "Voorzieningstype" }),
            values: {
              desk: message("Desk", { nl: "Bureau" }),
              office: message("Office", { nl: "Kantoor" }),
              meeting: message("Meeting room", { nl: "Vergaderruimte" }),
              event_space: message("Event space", { nl: "Evenementruimte" }),
            },
          },
        },
        hold_for: {
          type: "duration",
          default: 900000n,
          label: message("Hold duration", { nl: "Duur tijdelijke reservering" }),
        },
        active: { type: "bool", default: true },
        timezone: { type: "timezone" },
        currency: { type: "currency" },
        tax_rate: {
          type: "decimal",
          default: "0",
          min: "0",
          max: "1",
          label: message("Tax fraction", { nl: "Belastingfractie" }),
        },
        discount_rate: {
          type: "decimal",
          default: "0",
          min: "0",
          max: "1",
          label: message("Discount fraction", { nl: "Kortingsfractie" }),
        },
        cancellation_fee: {
          type: "money",
          nullable: true,
          default: null,
          label: message("Cancellation fee", { nl: "Annuleringskosten" }),
        },
        hourly: { type: "money", label: message("Hourly rate", { nl: "Uurtarief" }) },
        daily: {
          type: "money",
          nullable: true,
          default: null,
          label: message("Day rate", { nl: "Dagtarief" }),
        },
        price_unit: {
          type: "enum",
          cases: ["hour", "day"],
          default: "hour",
          label: {
            text: message("Price unit", { nl: "Prijseenheid" }),
            values: { hour: message("Hour", { nl: "Uur" }), day: message("Day", { nl: "Dag" }) },
          },
        },
        increment: {
          type: "duration",
          default: 3600000n,
          label: message("Booking increment", { nl: "Reserveringsstap" }),
        },
        minimum: {
          type: "duration",
          default: 3600000n,
          label: message("Minimum duration", { nl: "Minimumduur" }),
        },
        terms: {
          type: "text",
          label: message("Commercial terms", { nl: "Commerciële voorwaarden" }),
        },
        refund_notice: {
          type: "duration",
          label: message("Refund notice period", { nl: "Termijn voor terugbetaling" }),
        },
        buffer_before: {
          type: "duration",
          default: 0n,
          label: message("Buffer before", { nl: "Buffer vooraf" }),
        },
        buffer_after: {
          type: "duration",
          default: 0n,
          label: message("Buffer after", { nl: "Buffer achteraf" }),
        },
        amenities: {
          type: "text",
          array: true,
          default: [],
          label: message("Amenities", { nl: "Voorzieningen" }),
        },
        accessibility: {
          type: "text",
          label: message("Accessibility", { nl: "Toegankelijkheid" }),
        },
      },
    },
    "rent_reservations.Window": {
      parent: "rent_reservations.Resource",
      readGrants: [{ rule: "Window.read.1" }],
      label: message("Availability window", { nl: "Beschikbaarheidsvenster" }),
      invariants: ["Window.require.1"],
      fields: {
        from: { type: "datetime", label: message("From", { nl: "Van" }) },
        until: { type: "datetime", label: message("Until", { nl: "Tot" }) },
        closed: { type: "bool", default: false, label: message("Closed", { nl: "Gesloten" }) },
        reason: { type: "text", nullable: true, default: null },
      },
    },
    "rent_reservations.Booking": {
      exported: true,
      parent: "rent_reservations.Resource",
      readGrants: [
        { rule: "Booking.read.1" },
        {
          rule: "Booking.read.2",
          fields: [
            "customer",
            "account",
            "email",
            "from",
            "until",
            "quantity",
            "attendees",
            "status",
            "payment",
            "allowance",
            "checked_in",
            "checked_out",
            "overdue",
            "source",
          ],
        },
      ],
      label: message("Booking", { nl: "Reservering" }),
      invariants: ["Booking.require.1"],
      locks: ["Booking.lock.1", "Booking.lock.2"],
      fields: {
        billing_location: { type: Location, nullable: true, default: null },
        sale_product: { type: "text", nullable: true, default: null },
        purchased_at: { type: "datetime", nullable: true, default: null },
        attribution: { type: "text", nullable: true, default: null },
        exclusive_program: { type: "text", nullable: true, default: null },
        attributed_at: { type: "datetime", nullable: true, default: null },
        attribution_window: { type: "duration", nullable: true, default: null },
        customer: { type: Customer, label: message("Customer", { nl: "Klant" }) },
        account: { type: "user", label: message("User account", { nl: "Gebruikersaccount" }) },
        email: { type: "email" },
        from: { type: "datetime", label: message("From", { nl: "Van" }) },
        until: { type: "datetime", label: message("Until", { nl: "Tot" }) },
        approval: {
          type: BillingProfile,
          nullable: true,
          default: null,
          label: message("Invoice account approval", { nl: "Goedkeuring factuuraccount" }),
        },
        approval_version: {
          type: "int",
          nullable: true,
          default: null,
          label: message("Approval revision", { nl: "Goedkeuringsrevisie" }),
        },
        fulfillment_reason: {
          type: "text",
          nullable: true,
          default: null,
          label: message("Fulfillment reason", { nl: "Uitvoeringsreden" }),
        },
        quote: {
          type: AcceptedOffer,
          nullable: true,
          default: null,
          label: message("Accepted quote snapshot", { nl: "Geaccepteerde offertesnapshot" }),
        },
        benefit_intervals: { type: BenefitInterval, array: true, default: [] },
        benefit_rate: { type: "money", nullable: true, default: null },
        benefit_unit: {
          type: "enum",
          cases: ["hour", "day"],
          default: "hour",
          label: {
            text: message("Allowance unit", { nl: "Tegoedeenheid" }),
            values: { hour: message("Hour", { nl: "Uur" }), day: message("Day", { nl: "Dag" }) },
          },
        },
        benefit_duration: { type: "duration", default: 3600000n },
        arrival_buffer: { type: "duration", default: 0n },
        monetary_due: { type: "money", nullable: true, default: null },
        service_due: { type: "money", nullable: true, default: null },
        allowance_base: { type: "money", nullable: true, default: null },
        allowance_discount: { type: "money", nullable: true, default: null },
        allowance_tax: { type: "money", nullable: true, default: null },
        allowance_units: { type: "decimal", nullable: true, default: null },
        included_units: { type: "decimal", nullable: true, default: null },
        allowance_source: { type: "text", nullable: true, default: null },
        allowance_revision: { type: "int", default: 0n },
        allowance_reconcile_delivery: { type: "text", nullable: true, default: null },
        original_intervals: { type: "rent_reservations.BookingInterval", array: true, default: [] },
        intervals: {
          type: "rent_reservations.BookingInterval",
          array: true,
          default: [],
          label: message("Frozen access intervals", { nl: "Vastgelegde toegangstijdvakken" }),
        },
        quantity: { type: "int", default: 1n, min: 1n },
        attendees: {
          type: "int",
          default: 1n,
          min: 1n,
          label: message("Attendees", { nl: "Deelnemers" }),
        },
        tax_fraction: { type: "decimal", default: "0" },
        discount_fraction: { type: "decimal", default: "0" },
        subtotal: { type: "money", label: message("Subtotal", { nl: "Subtotaal" }) },
        tax: { type: "money", label: message("Frozen tax", { nl: "Vastgelegde belasting" }) },
        discount: {
          type: "money",
          label: message("Frozen discount", { nl: "Vastgelegde korting" }),
        },
        refund_amount: {
          type: "money",
          label: message("Refundable amount", { nl: "Terugbetaalbaar bedrag" }),
        },
        refund_requested: {
          type: "money",
          nullable: true,
          default: null,
          label: message("Requested refund amount", { nl: "Aangevraagd terugbetalingsbedrag" }),
        },
        rate: { type: "money", label: message("Frozen rate", { nl: "Vastgelegd tarief" }) },
        total: { type: "money" },
        terms: {
          type: "text",
          label: message("Commercial terms", { nl: "Commerciële voorwaarden" }),
        },
        refund_before: {
          type: "datetime",
          label: message("Refund deadline", { nl: "Terugbetalingsdeadline" }),
        },
        reserved_from: {
          type: "datetime",
          label: message("Capacity reserved from", { nl: "Capaciteit gereserveerd vanaf" }),
        },
        reserved_until: {
          type: "datetime",
          label: message("Capacity reserved until", { nl: "Capaciteit gereserveerd tot" }),
        },
        expires: { type: "datetime", label: message("Expires at", { nl: "Verloopt op" }) },
        status: {
          type: "enum",
          cases: [
            "held",
            "pending",
            "confirmed",
            "occupied",
            "completed",
            "cancelled",
            "expired",
            "review",
            "no_show",
          ],
          default: "held",
          label: {
            text: message("Status", { nl: "Status" }),
            values: {
              held: message("Held", { nl: "Tijdelijk gereserveerd" }),
              pending: message("Pending", { nl: "In afwachting" }),
              confirmed: message("Confirmed", { nl: "Bevestigd" }),
              occupied: message("Occupied", { nl: "In gebruik" }),
              completed: message("Completed", { nl: "Afgerond" }),
              cancelled: message("Cancelled", { nl: "Geannuleerd" }),
              expired: message("Expired", { nl: "Verlopen" }),
              review: message("Review required", { nl: "Beoordeling nodig" }),
            },
          },
        },
        payment: {
          type: "enum",
          cases: ["unpaid", "pending", "unknown", "paid", "refunded", "free", "on_account"],
          default: "unpaid",
          label: {
            text: message("Payment outcome", { nl: "Betaalresultaat" }),
            values: {
              pending: message("Pending", { nl: "In afwachting" }),
              unpaid: message("Unpaid", { nl: "Onbetaald" }),
              unknown: message("Unknown", { nl: "Onbekend" }),
              paid: message("Paid", { nl: "Betaald" }),
              refunded: message("Refunded", { nl: "Terugbetaald" }),
            },
          },
        },
        invoice: {
          type: "text",
          nullable: true,
          default: null,
          label: message("Invoice reference", { nl: "Factuurreferentie" }),
        },
        allowance: {
          type: "enum",
          cases: ["not_required", "pending", "reserved", "consumed", "released", "failed"],
          default: "not_required",
          label: {
            text: message("Membership allowance", { nl: "Lidmaatschapstegoed" }),
            values: {
              pending: message("Pending", { nl: "In afwachting" }),
              not_required: message("Not required", { nl: "Niet vereist" }),
              reserved: message("Reserved", { nl: "Gereserveerd" }),
              consumed: message("Consumed", { nl: "Verbruikt" }),
              released: message("Released", { nl: "Vrijgegeven" }),
              failed: message("Failed", { nl: "Mislukt" }),
            },
          },
        },
        source: {
          type: "text",
          unique: true,
          label: message("Source reference", { nl: "Bronreferentie" }),
        },
        checked_in: {
          type: "datetime",
          nullable: true,
          default: null,
          label: message("Actual arrival", { nl: "Werkelijke aankomst" }),
        },
        overdue: {
          type: "bool",
          default: false,
          label: message("Overdue occupancy", { nl: "Uitgelopen bezetting" }),
        },
        checked_out: {
          type: "datetime",
          nullable: true,
          default: null,
          label: message("Actual departure", { nl: "Werkelijk vertrek" }),
        },
        cancellation_restore: {
          type: "bool",
          default: false,
          label: message("Restore refundable allowance", {
            nl: "Terugbetaalbaar tegoed herstellen",
          }),
        },
        cancellation_reason: {
          type: "text",
          nullable: true,
          default: null,
          label: message("Cancellation reason", { nl: "Annuleringsreden" }),
        },
        billing_delivery: {
          type: "text",
          nullable: true,
          default: null,
          label: message("Billing delivery", { nl: "Facturatieverzending" }),
        },
        allowance_delivery: {
          type: "text",
          nullable: true,
          default: null,
          label: message("Allowance reservation delivery", { nl: "Verzending tegoedreservering" }),
        },
        consume_delivery: {
          type: "text",
          nullable: true,
          default: null,
          label: message("Allowance consumption delivery", { nl: "Verzending tegoedverbruik" }),
        },
        release_delivery: {
          type: "text",
          nullable: true,
          default: null,
          label: message("Allowance release delivery", { nl: "Verzending tegoedvrijgave" }),
        },
        refund_delivery: {
          type: "text",
          nullable: true,
          default: null,
          label: message("Refund request", { nl: "Terugbetalingsaanvraag" }),
        },
        refund_state: {
          type: "enum",
          cases: ["none", "pending", "unknown", "refunded", "review"],
          default: "none",
          label: message("Refund outcome", { nl: "Terugbetalingsresultaat" }),
        },
        collected: { type: "money", nullable: true, default: null },
        refunded: { type: "money", nullable: true, default: null },
        collection_pending: { type: "bool", default: false },
        refund_pending: { type: "bool", default: false },
        reconcile_delivery: { type: "text", nullable: true, default: null },
        cancel_delivery: { type: "text", nullable: true },
        settlement_revision: {
          type: "int",
          default: 0n,
          label: message("Settlement revision", { nl: "Afwikkelingsrevisie" }),
        },
        departure_buffer: {
          type: "duration",
          default: 0n,
          label: message("Departure buffer", { nl: "Vertrekbuffer" }),
        },
      },
    },
    "rent_reservations.Downtime": {
      parent: "rent_reservations.Resource",
      readGrants: [{ rule: "Downtime.read.1" }],
      label: message("Repair block", { nl: "Reparatieblokkade" }),
      fields: {
        source: {
          type: "text",
          unique: true,
          label: message("Source reference", { nl: "Bronreferentie" }),
        },
        from: { type: "datetime", label: message("From", { nl: "Van" }) },
        until: {
          type: "datetime",
          nullable: true,
          default: null,
          label: message("Until", { nl: "Tot" }),
        },
        reason: { type: "text" },
        active: { type: "bool", default: true },
        verified_by: {
          type: "user",
          nullable: true,
          default: null,
          label: message("Verified by", { nl: "Geverifieerd door" }),
        },
        verification: {
          type: "text",
          nullable: true,
          default: null,
          label: message("Repair verification", { nl: "Reparatieverificatie" }),
        },
      },
    },
    "rent_reservations.DayCalendar": {
      parent: "rent_reservations.Resource",
      fields: {
        day: { type: "date", unique: true },
        opens: { type: "text", default: "09:00" },
        closes: { type: "text", default: "18:00" },
        closed: { type: "bool", default: false },
        fold: {
          type: "enum",
          cases: ["earlier", "later"],
          default: "earlier",
          label: {
            text: message("Repeated local time", { nl: "Herhaalde lokale tijd" }),
            values: {
              earlier: message("Earlier occurrence", { nl: "Eerdere tijd" }),
              later: message("Later occurrence", { nl: "Latere tijd" }),
            },
          },
        },
      },
      label: message("Published day access", { nl: "Gepubliceerde dagtoegang" }),
      readGrants: [{ rule: "DayCalendar.read.1" }],
      invariants: ["DayCalendar.require.1"],
    },
    "rent_reservations.CapacityRevision": {
      parent: "rent_reservations.Resource",
      fields: {
        capacity: { type: "int", min: 1n },
        effective: {
          type: "datetime",
          server: "now",
          label: message("Effective at", { nl: "Van kracht vanaf" }),
        },
        reason: { type: "text" },
      },
      label: message("Capacity revision", { nl: "Capaciteitsrevisie" }),
      readGrants: [{ rule: "CapacityRevision.read.1" }],
      invariants: [],
    },
    "rent_reservations.Conflict": {
      parent: "rent_reservations.Resource",
      fields: {
        booking: { type: "rent_reservations.Booking" },
        downtime: { type: "rent_reservations.Downtime", nullable: true, default: null },
        reason: { type: "text" },
        resolved: { type: "bool", default: false },
        resolution: { type: "text", nullable: true, default: null },
      },
      label: message("Reservation conflict", { nl: "Reserveringsconflict" }),
      readGrants: [{ rule: "Conflict.read.1" }],
      invariants: [],
    },
    "rent_reservations.Desk": {
      parent: "rent_reservations.Resource",
      fields: {
        name: { type: "text", trim: true, min: 1n, unique: true },
        active: { type: "bool", default: true },
      },
      label: message("Pool desk", { nl: "Poolbureau" }),
      readGrants: [{ rule: "Desk.read.1" }],
      invariants: [],
    },
    "rent_reservations.Assignment": {
      parent: "rent_reservations.Booking",
      fields: {
        desk: { type: "rent_reservations.Desk" },
        from: { type: "datetime" },
        until: { type: "datetime" },
      },
      label: message("Dated desk assignment", { nl: "Gedateerde bureautoewijzing" }),
      readGrants: [{ rule: "Assignment.read.1" }, { rule: "Assignment.read.2" }],
      invariants: ["Assignment.require.1"],
    },
    "rent_reservations.Adjustment": {
      parent: "rent_reservations.Booking",
      fields: {
        source: { type: "text", unique: true },
        amount: { type: "money" },
        reason: { type: "text" },
        delivery: { type: "text", nullable: true, default: null },
        state: {
          type: "enum",
          cases: ["pending", "paid", "expired", "review", "refunded"],
          default: "pending",
          label: {
            text: message("State", { nl: "Status" }),
            values: {
              pending: message("Pending", { nl: "In behandeling" }),
              paid: message("Paid", { nl: "Betaald" }),
              expired: message("Expired", { nl: "Verlopen" }),
              review: message("Review required", { nl: "Beoordeling nodig" }),
              refunded: message("Refunded", { nl: "Terugbetaald" }),
            },
          },
        },
        original_until: { type: "datetime", nullable: true, default: null },
        original_reserved_until: { type: "datetime", nullable: true, default: null },
        new_until: { type: "datetime", nullable: true, default: null },
        expires: { type: "datetime", nullable: true, default: null },
        refund_delivery: { type: "text", nullable: true, default: null },
        invoice: { type: "text", nullable: true, default: null },
        movement: { type: "rent_reservations.Movement", nullable: true, default: null },
        settlement_revision: { type: "int", default: 0n },
        collected: { type: "money", nullable: true, default: null },
        refunded: { type: "money", nullable: true, default: null },
      },
      label: message("Separate booking adjustment", { nl: "Afzonderlijke reserveringscorrectie" }),
      readGrants: [{ rule: "Adjustment.read.1" }, { rule: "Adjustment.read.2" }],
      invariants: ["Adjustment.require.1"],
    },
    "rent_reservations.ResourcePolicy": {
      parent: "rent_reservations.Resource",
      readGrants: [{ rule: "ResourcePolicy.read.1" }],
      locks: ["ResourcePolicy.lock.1"],
      fields: {
        effective: { type: "datetime", server: "now" },
        sequence: { type: "int" },
        value: { type: "rent_reservations.ResourceEvidence" },
      },
    },
  },
  contracts: {
    "rent_reservations.LegacyBookingFacts": {label:message("Original booking facts", {nl:"Oorspronkelijke reserveringsgegevens"}),"fields": {"customer_source": {"type": "text", "nullable": true,label:message("Original customer system", {nl:"Oorspronkelijk klantsysteem"})}, "customer_external_id": {"type": "text", "nullable": true,label:message("Original customer key", {nl:"Oorspronkelijke klantsleutel"})}, "resource_source": {"type": "text", "nullable": true,label:message("Original resource system", {nl:"Oorspronkelijk voorzieningensysteem"})}, "resource_external_id": {"type": "text", "nullable": true,label:message("Original resource key", {nl:"Oorspronkelijke voorzieningssleutel"})}, "actor": {"type": "text", "nullable": true,label:message("Original booker", {nl:"Oorspronkelijke boeker"})}, "from_original": {"type": "text", "nullable": true,label:message("Original start timestamp", {nl:"Oorspronkelijke begintijd"})}, "until_original": {"type": "text", "nullable": true,label:message("Original end timestamp", {nl:"Oorspronkelijke eindtijd"})}, "from": {"type": "datetime", "nullable": true,label:message("Parsed start instant", {nl:"Geparst begintijdstip"})}, "until": {"type": "datetime", "nullable": true,label:message("Parsed end instant", {nl:"Geparst eindtijdstip"})}, "status": {"type": "text", "nullable": true,label:message("Original status", {nl:"Oorspronkelijke status"})}, "payment": {"type": "text", "nullable": true,label:message("Original payment status", {nl:"Oorspronkelijke betaalstatus"})}, "quantity": {"type": "int", "nullable": true,label:message("Original quantity", {nl:"Oorspronkelijk aantal"})}, "amount": {"type": "money", "nullable": true,label:message("Original amount", {nl:"Oorspronkelijk bedrag"})}}},
    "rent_reservations.AffectedBooking": {
      exported: true,
      fields: {
        reference: { type: "text" },
        revision: { type: "int" },
        from: { type: "datetime" },
        until: { type: "datetime" },
        quantity: { type: "int" },
        status: { field: "rent_reservations.Booking.status" },
        conflict: { type: "text", nullable: true },
      },
    },
    "rent_reservations.AffectedBookings": {
      exported: true,
      fields: {
        source: { type: "text" },
        resource: { type: "text" },
        revision: { type: "int" },
        checked_at: { type: "datetime" },
        items: { type: "rent_reservations.AffectedBooking", array: true },
      },
    },
    "rent_reservations.WorkspaceAvailability": {
      fields: {
        resource: { type: "rent_reservations.Resource" },
        from: { type: "datetime" },
        until: { type: "datetime" },
        quantity: { type: "int" },
        attendees: { type: "int" },
        available: {
          type: "bool",
          label: {
            text: message("Availability", { nl: "Beschikbaarheid" }),
            values: {
              true: message("Available", { nl: "Beschikbaar" }),
              false: message("Unavailable", { nl: "Niet beschikbaar" }),
            },
          },
        },
        total: { type: "money" },
        terms: { type: "text" },
        refund_before: { type: "datetime" },
      },
    },
    "rent_reservations.DayAvailability": {
      fields: {
        resource: { type: "rent_reservations.Resource" },
        start: { type: "date" },
        end: { type: "date" },
        quantity: { type: "int" },
        attendees: { type: "int" },
        available: {
          type: "bool",
          label: {
            text: message("Availability", { nl: "Beschikbaarheid" }),
            values: {
              true: message("Available", { nl: "Beschikbaar" }),
              false: message("Unavailable", { nl: "Niet beschikbaar" }),
            },
          },
        },
        total: { type: "money" },
        terms: { type: "text" },
      },
    },
    "rent_reservations.ReservationOfferOutcome": {
      exported: true,
      fields: {
        source: { type: "text" },
        revision: { type: "int" },
        kind: {
          type: "enum",
          cases: ["hold", "booking", "release"],
          label: {
            text: message("Kind", { nl: "Soort" }),
            values: {
              hold: message("Temporary hold", { nl: "Tijdelijke reservering" }),
              booking: message("Booking", { nl: "Boeking" }),
              release: message("Release", { nl: "Vrijgave" }),
            },
          },
        },
        version: { type: "int" },
        state: {
          type: "enum",
          cases: ["pending", "confirmed", "unavailable", "failed", "unknown", "released"],
          label: {
            text: message("State", { nl: "Status" }),
            values: {
              pending: message("Pending", { nl: "In behandeling" }),
              confirmed: message("Confirmed", { nl: "Bevestigd" }),
              unavailable: message("Unavailable", { nl: "Niet beschikbaar" }),
              failed: message("Failed", { nl: "Mislukt" }),
              unknown: message("Unknown", { nl: "Onbekend" }),
              released: message("Released", { nl: "Vrijgegeven" }),
            },
          },
        },
        reference: { type: "text", nullable: true, default: null },
        detail: { type: "text", nullable: true, default: null },
        invoice: { type: "text", nullable: true, default: null },
        expires: { type: "datetime", nullable: true, default: null },
      },
      label: message("Quote reservation outcome", { nl: "Offerte-reserveringsresultaat" }),
    },
    "rent_reservations.BookingInterval": {
      fields: { from: { type: "datetime" }, until: { type: "datetime" } },
    },
    "rent_reservations.RoomRequest": {
      exported: true,
      label: message("Workspace request", { nl: "Werkplekaanvraag" }),
      fields: {
        source: { type: "text", label: message("Source reference", { nl: "Bronreferentie" }) },
        revision: { type: "int", default: 1n },
        resource: {
          type: "text",
          label: message("Resource reference", { nl: "Voorzieningsreferentie" }),
        },
        customer: { type: "text", label: message("Customer reference", { nl: "Klantreferentie" }) },
        account: { type: "user", label: message("User account", { nl: "Gebruikersaccount" }) },
        from: { type: "datetime", label: message("From", { nl: "Van" }) },
        until: { type: "datetime", label: message("Until", { nl: "Tot" }) },
        quantity: { type: "int" },
        price: { type: "money", nullable: true, default: null },
        terms: {
          type: "text",
          nullable: true,
          default: null,
          label: message("Commercial terms", { nl: "Commerciële voorwaarden" }),
        },
      },
    },
    "rent_reservations.ReportWindow": {
      fields: { from: { type: "datetime" }, until: { type: "datetime" }, closed: { type: "bool" } },
    },
    "rent_reservations.ReportDowntime": {
      fields: {
        from: { type: "datetime" },
        until: { type: "datetime", nullable: true },
        active: { type: "bool" },
      },
    },
    "rent_reservations.ReportBooking": {
      fields: {
        from: { type: "datetime" },
        until: { type: "datetime" },
        intervals: { type: "rent_reservations.BookingInterval", array: true },
        quantity: { type: "int" },
        status: { type: "rent_reservations.Booking.status" },
        checked_in: { type: "datetime", nullable: true },
        checked_out: { type: "datetime", nullable: true },
        arrival_buffer: { type: "duration" },
        departure_buffer: { type: "duration" },
      },
    },
    "rent_reservations.ReportVenue": {
      fields: {
        from: { type: "datetime" },
        until: { type: "datetime" },
        quantity: { type: "int" },
        status: { type: "rent_reservations.VenueReservation.status" },
      },
    },
    "rent_reservations.ResourceEvidence": {
      fields: {
        active: { type: "bool" },
        capacity: { type: "int" },
        pooled: { type: "bool" },
        timezone: { type: "timezone" },
        windows: { type: "rent_reservations.ReportWindow", array: true },
        downtime: { type: "rent_reservations.ReportDowntime", array: true },
        bookings: { type: "rent_reservations.ReportBooking", array: true },
        venues: { type: "rent_reservations.ReportVenue", array: true },
      },
    },
  },
  events: {
    "rent_reservations.CommercialCheck": {
      fields: { booking: { type: "rent_reservations.Booking" } },
    },
    "rent_reservations.CommercialSaleChanged": {
      exported: true,
      fields: { value: { type: SaleMilestone } },
    },
    "rent_reservations.AffectedOutcome": {
      exported: true,
      fields: { value: { type: "rent_reservations.AffectedBookings" } },
    },
    "rent_reservations.MovementDue": {
      fields: { movement: { type: "rent_reservations.Movement" } },
    },
    "rent_reservations.MovementObserved": {
      fields: {
        movement: { type: "rent_reservations.Movement" },
        value: { type: AllowanceOutcome },
      },
    },
    "rent_reservations.AllowanceObserved": {
      fields: { booking: { type: "rent_reservations.Booking" }, value: { type: AllowanceOutcome } },
    },
    "rent_reservations.OccupancyDue": {
      fields: { booking: { type: "rent_reservations.Booking" } },
    },
    "rent_reservations.SettlementObserved": { fields: { value: { type: Settlement } } },
    "rent_reservations.AdjustmentDue": {
      fields: { adjustment: { type: "rent_reservations.Adjustment" } },
    },
    "rent_reservations.VenueOutcome": {
      exported: true,
      fields: { value: { type: OperationOutcome } },
    },
    "rent_reservations.OfferOutcome": {
      exported: true,
      fields: { value: { type: "rent_reservations.ReservationOfferOutcome" } },
    },
    "rent_reservations.VenueDue": {
      fields: { venue: { type: "rent_reservations.VenueReservation" } },
    },
    "rent_reservations.QuoteDue": { fields: { hold: { type: "rent_reservations.QuoteHold" } } },
    "rent_reservations.Reminder": {
      fields: { booking: { type: "rent_reservations.Booking" }, revision: { type: "int" } },
    },
    "rent_reservations.HoldDue": { fields: { booking: { type: "rent_reservations.Booking" } } },
    "rent_reservations.ReservationChanged": {
      exported: true,
      fields: { booking: { type: "rent_reservations.Booking" }, revision: { type: "int" } },
    },
  },
  capabilities: {
    "rent_reservations.RoomsV1": {
      exported: true,
      version: 1n,
      providerImplementation: {
        ingress: "rent_reservations.RoomsIngressV1",
        outcomes: [
          "rent_reservations.VenueOutcome",
          "rent_reservations.OfferOutcome",
          "rent_reservations.AffectedOutcome",
        ],
        installed: false,
      },
      operations: {
        affected: {
          inputs: { source: { type: "text" }, resource: { type: "text" } },
          result: "rent_reservations.AffectedBookings",
        },
        stage: {
          inputs: {
            value: { type: "rent_reservations.RoomRequest" },
            previous_source: { type: "text" },
            previous_revision: { type: "int" },
          },
          result: OperationOutcome,
        },
        hold_offer: {
          inputs: { value: { type: QuoteOffer } },
          result: "rent_reservations.ReservationOfferOutcome",
        },
        accept_offer: {
          inputs: { value: { type: AcceptedOffer } },
          result: "rent_reservations.ReservationOfferOutcome",
        },
        release_offer: {
          inputs: {
            source: { type: "text" },
            revision: { type: "int" },
            resource: { type: "text" },
            reason: { type: "text" },
          },
          result: "rent_reservations.ReservationOfferOutcome",
        },
        hold: {
          inputs: { value: { type: "rent_reservations.RoomRequest" } },
          result: OperationOutcome,
        },
        confirm: {
          inputs: { source: { type: "text" }, resource: { type: "text" } },
          result: OperationOutcome,
        },
        move: {
          inputs: { value: { type: "rent_reservations.RoomRequest" } },
          result: OperationOutcome,
        },
        release: {
          inputs: {
            source: { type: "text" },
            resource: { type: "text" },
            reason: { type: "text" },
          },
          result: OperationOutcome,
        },
        downtime: {
          inputs: {
            source: { type: "text" },
            resource: { type: "text" },
            from: { type: "datetime" },
            until: { type: "datetime", nullable: true },
          },
          result: OperationOutcome,
        },
        restore: {
          inputs: {
            source: { type: "text" },
            resource: { type: "text" },
            evidence: { type: "text" },
          },
          result: OperationOutcome,
        },
      },
      events: {
        "rent_reservations.MovementCleared": {
          fields: { movement: { type: "rent_reservations.Movement" } },
        },
        changed: { fields: { value: { type: OperationOutcome } } },
        offer_changed: { fields: { value: { type: "rent_reservations.ReservationOfferOutcome" } } },
      },
    },
    "rent_reservations.RoomsIngressV1": {
      exported: true,
      version: 1n,
      events: {
        affected: { fields: { source: { type: "text" }, resource: { type: "text" } } },
        move: { fields: { value: { type: "rent_reservations.RoomRequest" } } },
        downtime: {
          fields: {
            source: { type: "text" },
            resource: { type: "text" },
            from: { type: "datetime" },
            until: { type: "datetime", nullable: true },
          },
        },
        restore: {
          fields: {
            source: { type: "text" },
            resource: { type: "text" },
            evidence: { type: "text" },
          },
        },
        hold: { fields: { value: { type: "rent_reservations.RoomRequest" } } },
        stage: {
          fields: {
            value: { type: "rent_reservations.RoomRequest" },
            previous_source: { type: "text" },
            previous_revision: { type: "int" },
          },
        },
        confirm: { fields: { source: { type: "text" }, resource: { type: "text" } } },
        release: {
          fields: {
            source: { type: "text" },
            resource: { type: "text" },
            reason: { type: "text" },
          },
        },
        hold_offer: { fields: { value: { type: QuoteOffer } } },
        accept_offer: { fields: { value: { type: AcceptedOffer } } },
        release_offer: {
          fields: {
            source: { type: "text" },
            revision: { type: "int" },
            resource: { type: "text" },
            reason: { type: "text" },
          },
        },
      },
    },
  },
  pure: {
    "rent_reservations.may_move": { handler: "may_move", inputs: { booking: { type: Booking } }, result: "bool" },
    "rent_reservations.may_reserve": { handler: "may_reserve", inputs: { account: { type: "user" }, customer: { type: Customer }, resource: { type: "rent_reservations.Resource" } }, result: "bool" },
    "rent_reservations.can_read_booking_details": {
      handler: "can_read_booking_details", exported: true,
      inputs: { booking: { type: Booking } }, result: "bool",
    },
    "rent_reservations.commercial": {
      handler: "commercial",
      inputs: {
        booking: { type: "rent_reservations.Booking" },
        sale: { type: "rent_reservations.CommercialSale" },
        location: { type: Location },
        product: { type: "text" },
        amount: { type: "money" },
        purchased: { type: "datetime" },
        phase: { type: "invoice.SaleMilestone.milestone" },
        at: { type: "datetime" },
      },
      result: SaleMilestone,
    },
    "rent_reservations.quote_covers": {
      handler: "quote_covers",
      inputs: { hold: { type: "rent_reservations.QuoteHold" }, point: { type: "datetime" } },
      result: "bool",
    },
    "rent_reservations.quote_available": {
      handler: "quote_available",
      inputs: {
        resource: { type: "rent_reservations.Resource" },
        value: { type: QuoteDocument },
        quantity: { type: "int" },
      },
      result: "bool",
    },
    "rent_reservations.next_boundary": {
      handler: "next_boundary",
      inputs: {
        points: { type: "datetime", array: true },
        left: { type: "datetime" },
        until: { type: "datetime" },
      },
      result: "datetime",
    },
    "rent_reservations.financial_cover": {
      handler: "financial_cover",
      inputs: { booking: { type: "rent_reservations.Booking" } },
      result: "bool",
    },
    "rent_reservations.credit_baseline": {
      handler: "credit_baseline",
      inputs: { charge_source: { type: "text" }, current: { type: "money" } },
      result: "money",
    },
    "rent_reservations.movement_busy": {
      handler: "movement_busy",
      inputs: { movement: { type: "rent_reservations.Movement" } },
      result: "bool",
    },
    "rent_reservations.movement_covers": {
      handler: "movement_covers",
      inputs: { movement: { type: "rent_reservations.Movement" }, point: { type: "datetime" } },
      result: "bool",
    },
    "rent_reservations.movement_request": {
      handler: "movement_request",
      inputs: { movement: { type: "rent_reservations.Movement" } },
      result: Entitlement,
    },
    "rent_reservations.benefit_request": {
      handler: "benefit_request",
      inputs: { booking: { type: "rent_reservations.Booking" } },
      result: Entitlement,
    },
    "rent_reservations.charge_request": {
      handler: "charge_request",
      inputs: {
        booking: { type: "rent_reservations.Booking" },
        base: { type: "money" },
        discount: { type: "money" },
        tax: { type: "money" },
      },
      result: Charge,
    },
    "rent_reservations.covers": {
      handler: "covers",
      inputs: { b: { type: "rent_reservations.Booking" }, point: { type: "datetime" } },
      result: "bool",
    },
    "rent_reservations.venue_busy": {
      handler: "venue_busy",
      inputs: { venue: { type: "rent_reservations.VenueReservation" } },
      result: "bool",
    },
    "rent_reservations.venue_covers": {
      handler: "venue_covers",
      inputs: {
        venue: { type: "rent_reservations.VenueReservation" },
        point: { type: "datetime" },
      },
      result: "bool",
    },
    "rent_reservations.credit_allowed": {
      handler: "credit_allowed",
      inputs: { customer: { type: Customer }, resource: { type: "rent_reservations.Resource" } },
      result: "bool",
    },
    "rent_reservations.bookable": {
      handler: "bookable",
      inputs: { booking: { type: "rent_reservations.Booking" } },
      result: "bool",
    },
    "rent_reservations.free_at": {
      handler: "free_at",
      inputs: {
        resource: { type: "rent_reservations.Resource" },
        point: { type: "datetime" },
        quantity: { type: "int" },
        skip: { type: "rent_reservations.Booking", nullable: true },
        skip_venue: { type: "rent_reservations.VenueReservation", nullable: true, default: null },
      },
      result: "bool",
    },
    "rent_reservations.busy": {
      handler: "busy",
      inputs: { b: { type: "rent_reservations.Booking" } },
      result: "bool",
    },
    "rent_reservations.free": {
      handler: "free",
      inputs: {
        resource: { type: "rent_reservations.Resource" },
        from: { type: "datetime" },
        until: { type: "datetime" },
        quantity: { type: "int" },
        skip: { type: "rent_reservations.Booking", nullable: true },
        skip_venue: { type: "rent_reservations.VenueReservation", nullable: true, default: null },
      },
      result: "bool",
    },
    "rent_reservations.resource_evidence": {
      handler: "resource_evidence",
      inputs: { resource: { type: "rent_reservations.Resource" } },
      result: "rent_reservations.ResourceEvidence",
    },
    "rent_reservations.saved_service": {
      handler: "saved_service",
      inputs: { booking: { type: "rent_reservations.ReportBooking" }, point: { type: "datetime" } },
      result: "bool",
    },
    "rent_reservations.saved_saleable": {
      handler: "saved_saleable",
      inputs: {
        policy: { type: "rent_reservations.ResourcePolicy" },
        opening: { type: LocationPolicy },
        left: { type: "datetime" },
        right: { type: "datetime" },
      },
      result: "bool",
    },
    "rent_reservations.saved_rows": {
      handler: "saved_rows",
      inputs: {
        resource: { type: "rent_reservations.Resource" },
        points: { type: "datetime", array: true },
        until: { type: "datetime" },
      },
      result: { type: Contribution, array: true },
    },
  },
  preferences: {
    rent_catalog_ui: {
      fields: {
        arrival_open: {
          type: "bool",
          default: false,
          label: message("Show arrival instructions", { nl: "Aankomstinstructies tonen" }),
        },
      },
    },
    rent_reservations: { fields: { location: { type: Location, nullable: true, default: null } } },
    rent_reporting: { fields: { location: { type: Location, nullable: true, default: null } } },
  },
  operations: {
    "rent_reservations.retain_legacy": {handler:"retain_legacy",exported:true,read:false,by:"rent_reservations.reservation_manager",result:LegacyBooking,label:message("Retain historical booking", {nl:"Historische reservering bewaren"}),description:message("Retain historical booking assertions without capacity, billing or allowance effects.", {nl:"Bewaar historische reserveringsclaims zonder capaciteit, facturatie of tegoeden te wijzigen."}),inputs:{source:{type:"text",label:message("Source system", {nl:"Bronsysteem"})},external_id:{type:"text",label:message("Original record key", {nl:"Oorspronkelijke recordsleutel"})},location:{type:Location,label:message("Current location scope", {nl:"Huidig locatiebereik"})},facts:{type:"rent_reservations.LegacyBookingFacts",label:message("Original booking facts", {nl:"Oorspronkelijke reserveringsgegevens"})},source_evidence:{type:"file",label:message("Original source artifact", {nl:"Oorspronkelijk bronbestand"})},attestation:{type:"text",label:message("Intake attestation", {nl:"Verklaring bij invoer"})}}},
    "rent_reservations.legacy_matches": {handler:"legacy_matches",read:true,by:"authenticated",result:"rent_reservations.LegacyBooking[]",label:message("Find historical booking", {nl:"Historische reservering zoeken"}),description:message("Find readable source identities; the preview cannot reserve an import key.", {nl:"Zoek leesbare bronidentiteiten; het voorbeeld reserveert geen invoersleutel."}),inputs:{source:{type:"text",label:message("Source system", {nl:"Bronsysteem"})},external_id:{type:"text",label:message("Original record key", {nl:"Oorspronkelijke recordsleutel"})},location:{type:Location,label:message("Current location scope", {nl:"Huidig locatiebereik"})}}},
    "rent_reservations.link_legacy": {handler:"link_legacy",exported:true,read:false,by:["rent_reservations.reservation_manager","invoice.finance"],label:message("Map historical booking", {nl:"Historische reservering koppelen"}),description:message("Review current references and access independently of original source facts.", {nl:"Beoordeel huidige verwijzingen en toegang los van de oorspronkelijke brongegevens."}),inputs:{entry:{type:LegacyBooking},customer:{type:Customer,nullable:true,label:message("Current customer", {nl:"Huidige klant"})},resource:{type:Resource,nullable:true,label:message("Current resource", {nl:"Huidige voorziening"})},account:{type:"user",nullable:true,label:message("Current account", {nl:"Huidig account"})},reason:{type:"text",label:message("Review reason", {nl:"Reden voor beoordeling"})}}},
    "rent_reservations.resource_report": {
      description: message(
        "Export saved calendar and resource evidence; dates before the first capture remain partial.",
        {
          nl: "Exporteer vastgelegd kalender- en voorzieningsbewijs; datums vóór de eerste vastlegging blijven gedeeltelijk.",
        },
      ),
      handler: "resource_report",
      exported: true,
      read: true,
      scope: "authority",
      by: "rent_reservations.reservation_manager",
      inputs: {
        resource: { type: "rent_reservations.Resource" },
        from: { type: "datetime" },
        until: { type: "datetime" },
      },
      result: ReportBatch,
      label: message("Workspace source measures", { nl: "Werkplekbronmaatstaven" }),
    },
    "rent_reservations.refund_movement_credit": {
      handler: "refund_movement_credit",
      by: "rent_reservations.billing",
      inputs: {
        movement: { type: "rent_reservations.Movement" },
        charge_source: { type: "text" },
        amount: { type: "money" },
        reason: { type: "text" },
      },
      label: message("Refund movement credit", { nl: "Verplaatsingstegoed terugbetalen" }),
      read: false,
    },
    "rent_reservations.resend_notice": {
      handler: "resend_notice",
      exported: true,
      by: ["authenticated", "rent_reservations.reception"],
      inputs: { notice: { type: "rent_reservations.Notice" } },
      label: message("Retry booking notice", { nl: "Reserveringsbericht opnieuw proberen" }),
      read: false,
    },
    "rent_reservations.move_membership": {
      description: message(
        "Retain the current capacity and consumed benefit until the candidate commits.",
        {
          nl: "Behoud de huidige capaciteit en het verbruikte voordeel totdat de kandidaat vastgelegd is.",
        },
      ),
      handler: "move_membership",
      exported: true,
      by: "authenticated",
      inputs: {
        booking: { type: "rent_reservations.Booking" },
        from: { type: "datetime" },
        until: { type: "datetime" },
      },
      label: message("Move member workspace", { nl: "Ledenwerkplek verplaatsen" }),
      read: false,
    },
    "rent_reservations.move_membership_days": {
      handler: "move_membership_days",
      exported: true,
      by: "authenticated",
      inputs: {
        booking: { type: "rent_reservations.Booking" },
        start: { type: "date" },
        end: { type: "date" },
      },
      label: message("Move member workspace days", { nl: "Ledenwerkplekdagen verplaatsen" }),
      read: false,
    },
    "rent_reservations.retry_movement_cleanup": {
      handler: "retry_movement_cleanup",
      exported: true,
      by: "authenticated",
      inputs: { movement: { type: "rent_reservations.Movement" } },
      label: message("Retry workspace move cleanup", {
        nl: "Opruimen werkplekverplaatsing opnieuw proberen",
      }),
      read: false,
    },
    "rent_reservations.abandon_movement": {
      handler: "abandon_movement",
      exported: true,
      by: "authenticated",
      inputs: { movement: { type: "rent_reservations.Movement" } },
      label: message("Abandon workspace move", { nl: "Werkplekverplaatsing afbreken" }),
      read: false,
    },
    "rent_reservations.reconcile_movement": {
      handler: "reconcile_movement",
      exported: true,
      by: "authenticated",
      inputs: { movement: { type: "rent_reservations.Movement" } },
      label: message("Reconcile workspace move", { nl: "Werkplekverplaatsing reconciliëren" }),
      read: false,
    },
    "rent_reservations.reconcile_allowance": {
      handler: "reconcile_allowance",
      exported: true,
      by: ["authenticated", "rent_reservations.reception"],
      inputs: { booking: { type: "rent_reservations.Booking" } },
      label: message("Reconcile membership allowance", { nl: "Lidmaatschapstegoed reconciliëren" }),
      read: false,
    },
    "rent_reservations.reconcile_booking": {
      handler: "reconcile_booking",
      exported: true,
      by: ["authenticated", "rent_reservations.reception", "rent_reservations.billing"],
      inputs: { booking: { type: "rent_reservations.Booking" } },
      label: message("Reconcile booking payment", { nl: "Reserveringsbetaling reconciliëren" }),
      read: false,
    },
    "rent_reservations.available": {
      handler: "available",
      by: "public",
      read: true,
      scope: "authority",
      result: "rent_reservations.WorkspaceAvailability",
      description: message(
        "Expose this resource's current eligibility and published full price without customer records.",
        {
          nl: "Toon de huidige geschiktheid en gepubliceerde volledige prijs van deze voorziening zonder klantgegevens.",
        },
      ),
      inputs: {
        resource: { type: "rent_reservations.Resource" },
        from: { type: "datetime" },
        until: { type: "datetime" },
        quantity: { type: "int", default: 1n },
        attendees: { type: "int", default: 1n },
        amenities: { type: "text", array: true, default: [] },
      },
      label: message("Check workspace availability", { nl: "Werkplekbeschikbaarheid controleren" }),
    },
    "rent_reservations.available_days": {
      handler: "available_days",
      by: "public",
      read: true,
      scope: "authority",
      result: "rent_reservations.DayAvailability",
      description: message(
        "Reveal day eligibility using only the selected resource's authoritative published dates.",
        {
          nl: "Toon daggeschiktheid met uitsluitend de gezaghebbende gepubliceerde datums van de geselecteerde voorziening.",
        },
      ),
      inputs: {
        resource: { type: "rent_reservations.Resource" },
        start: { type: "date" },
        end: { type: "date" },
        quantity: { type: "int", default: 1n },
        attendees: { type: "int", default: 1n },
        amenities: { type: "text", array: true, default: [] },
      },
      label: message("Check workspace days", { nl: "Werkplekdagen controleren" }),
    },
    "rent_reservations.extend": {
      description: message(
        "Hold an extension while retaining the original access until its separate price is fulfilled.",
        {
          nl: "Houd een verlenging vast en behoud de oorspronkelijke toegang totdat de afzonderlijke prijs voldaan is.",
        },
      ),
      exported: true,
      handler: "extend",
      by: ["authenticated", "rent_reservations.reception", "rent_reservations.billing"],
      inputs: {
        booking: { type: "rent_reservations.Booking" },
        until: { type: "datetime" },
        reason: { type: "text" },
        amount: { type: "money", nullable: true, default: null },
      },
      label: message("Extend booking", { nl: "Reservering verlengen" }),
      read: false,
    },
    "rent_reservations.refund_adjustment": {
      handler: "refund_adjustment",
      by: "rent_reservations.billing",
      inputs: { adjustment: { type: "rent_reservations.Adjustment" }, reason: { type: "text" } },
      label: message("Refund adjustment exception", { nl: "Correctie-uitzondering terugbetalen" }),
      read: false,
    },
    "rent_reservations.hold_days": {
      description: message("Reserve every published local day together at the frozen day price.", {
        nl: "Reserveer elke gepubliceerde lokale dag samen tegen de vastgelegde dagprijs.",
      }),
      handler: "hold_days",
      result: "rent_reservations.Booking",
      by: ["authenticated", "rent_reservations.reception"],
      inputs: {
        resource: { type: "rent_reservations.Resource" },
        customer: { type: Customer },
        start: { type: "date" },
        end: { type: "date" },
        quantity: { type: "int" },
        email: { type: "email" },
        account: {
          type: "user",
          nullable: true,
          default: null,
          label: message("Booking account", { nl: "Reserveringsaccount" }),
        },
        attendees: { type: "int", default: 1n },
        capture: { type: Capture, nullable: true, default: null },
        use_allowance: { type: "bool", default: false },
      },
      label: message("Hold workspace days", { nl: "Werkplekdagen tijdelijk reserveren" }),
      read: false,
    },
    "rent_reservations.DayCalendar.create": {
      handler: "createDayCalendar",
      model: "rent_reservations.DayCalendar",
      kind: "create",
      by: "rent_reservations.reservation_manager",
      inputs: {
        parent: { type: "rent_reservations.Resource" },
        fields: ["day", "opens", "closes", "closed", "fold"],
      },
      read: false,
      when: "DayCalendar",
    },
    "rent_reservations.DayCalendar.update": {
      handler: "updateDayCalendar",
      model: "rent_reservations.DayCalendar",
      kind: "update",
      by: "rent_reservations.reservation_manager",
      inputs: {
        record: { type: "rent_reservations.DayCalendar" },
        changes: { fields: ["day", "opens", "closes", "closed", "fold"] },
      },
      read: false,
      when: "DayCalendar",
    },
    "rent_reservations.Resource.create": {
      handler: "createResource",
      model: "rent_reservations.Resource",
      kind: "create",
      by: catalog_owner,
      inputs: {
        fields: [
          "location",
          "name",
          "pooled",
          "capacity",
          "timezone",
          "currency",
          "hourly",
          "daily",
          "price_unit",
          "tax_rate",
          "discount_rate",
          "cancellation_fee",
          "terms",
          "refund_notice",
          "accessibility",
          "party_limit",
          "kind",
          "hold_for",
        ],
      },
      read: false,
      when: "Resource",
    },
    "rent_reservations.Resource.update": {
      handler: "updateResource",
      model: "rent_reservations.Resource",
      kind: "update",
      by: catalog_owner,
      inputs: {
        record: { type: "rent_reservations.Resource" },
        changes: {
          fields: [
            "name",
            "active",
            "hourly",
            "daily",
            "price_unit",
            "tax_rate",
            "discount_rate",
            "cancellation_fee",
            "increment",
            "minimum",
            "terms",
            "refund_notice",
            "buffer_before",
            "buffer_after",
            "amenities",
            "accessibility",
            "party_limit",
            "kind",
            "hold_for",
          ],
        },
      },
      read: false,
      when: "Resource",
    },
    "rent_reservations.Window.create": {
      handler: "createWindow",
      model: "rent_reservations.Window",
      kind: "create",
      by: "rent_reservations.reservation_manager",
      inputs: {
        parent: { type: "rent_reservations.Resource" },
        fields: ["from", "until", "closed", "reason"],
      },
      read: false,
      when: "Window",
    },
    "rent_reservations.Window.update": {
      handler: "updateWindow",
      model: "rent_reservations.Window",
      kind: "update",
      by: "rent_reservations.reservation_manager",
      inputs: {
        record: { type: "rent_reservations.Window" },
        changes: { fields: ["from", "until", "closed", "reason"] },
      },
      read: false,
      when: "Window",
    },
    "rent_reservations.hold": {
      handler: "hold",
      result: "rent_reservations.Booking",
      by: ["authenticated", "rent_reservations.reception"],
      label: message("Hold workspace", { nl: "Werkplek tijdelijk reserveren" }),
      description: message(
        "Hold a published interval at its frozen price; confirmation remains pending billing and allowance.",
        {
          nl: "Reserveer een gepubliceerd tijdvak tijdelijk tegen de vastgelegde prijs; bevestiging blijft afhankelijk van facturatie en tegoed.",
        },
      ),
      inputs: {
        resource: { type: "rent_reservations.Resource" },
        customer: { type: Customer },
        from: { type: "datetime", label: message("From", { nl: "Van" }) },
        until: { type: "datetime", label: message("Until", { nl: "Tot" }) },
        quantity: { type: "int" },
        email: { type: "email" },
        account: {
          type: "user",
          nullable: true,
          default: null,
          label: message("Booking account", { nl: "Reserveringsaccount" }),
        },
        attendees: { type: "int", default: 1n, label: message("Attendees", { nl: "Deelnemers" }) },
        capture: { type: Capture, nullable: true, default: null },
        use_allowance: {
          type: "bool",
          default: false,
          label: message("Use membership allowance", { nl: "Lidmaatschapstegoed gebruiken" }),
        },
      },
      read: false,
    },
    "rent_reservations.move": {
      exported: true,
      handler: "move",
      by: "authenticated",
      label: message("Move held booking", { nl: "Tijdelijke reservering verplaatsen" }),
      description: message(
        "Move a still-held interval atomically while retaining the original on conflict.",
        {
          nl: "Verplaats een nog tijdelijke reservering atomair en behoud bij een conflict het oorspronkelijke tijdvak.",
        },
      ),
      inputs: {
        booking: { type: "rent_reservations.Booking" },
        from: { type: "datetime", label: message("From", { nl: "Van" }) },
        until: { type: "datetime", label: message("Until", { nl: "Tot" }) },
      },
      read: false,
    },
    "rent_reservations.block": {
      handler: "block",
      by: "rent_reservations.reservation_manager",
      label: message("Block for repair", { nl: "Blokkeren voor reparatie" }),
      description: message(
        "Record a timed or indefinite repair block without erasing affected bookings.",
        {
          nl: "Leg een tijdelijke of onbepaalde reparatieblokkade vast zonder getroffen reserveringen te wissen.",
        },
      ),
      inputs: {
        resource: { type: "rent_reservations.Resource" },
        from: { type: "datetime", label: message("From", { nl: "Van" }) },
        until: {
          type: "datetime",
          nullable: true,
          default: null,
          label: message("Until", { nl: "Tot" }),
        },
        reason: { type: "text" },
      },
      read: false,
    },
    "rent_reservations.restore": {
      handler: "restore",
      by: "rent_reservations.reservation_manager",
      label: message("Restore availability", { nl: "Beschikbaarheid herstellen" }),
      description: message("Restore only the specified manager-verified repair block.", {
        nl: "Herstel alleen de opgegeven reparatieblokkade die een beheerder heeft geverifieerd.",
      }),
      inputs: { downtime: { type: "rent_reservations.Downtime" }, evidence: { type: "text" } },
      read: false,
    },
    "rent_reservations.prepare": {
      exported: true,
      handler: "prepare",
      by: ["authenticated", "rent_reservations.reception"],
      label: message("Request booking fulfillment", { nl: "Reserveringsuitvoering aanvragen" }),
      description: message("Queue this booking's charge and optional allowance reservation once.", {
        nl: "Zet de kosten en optionele tegoedreservering voor deze reservering eenmalig in de wachtrij.",
      }),
      inputs: {
        booking: { type: "rent_reservations.Booking" },
        use_allowance: {
          type: "bool",
          default: false,
          label: message("Use membership allowance", { nl: "Lidmaatschapstegoed gebruiken" }),
        },
      },
      read: false,
    },
    "rent_reservations.arrive": {
      exported: true,
      handler: "arrive",
      by: "rent_reservations.reception",
      label: message("Record arrival", { nl: "Aankomst vastleggen" }),
      description: message(
        "Admit a fulfilled booking and retain physical possession beyond its estimated end.",
        {
          nl: "Laat een voldane reservering toe en behoud werkelijk gebruik na de geschatte eindtijd.",
        },
      ),
      inputs: { booking: { type: "rent_reservations.Booking" } },
      read: false,
    },
    "rent_reservations.depart": {
      exported: true,
      handler: "depart",
      by: "rent_reservations.reception",
      label: message("Record departure", { nl: "Vertrek vastleggen" }),
      description: message("Clear only this booking's current physical possession.", {
        nl: "Beëindig alleen het huidige werkelijke gebruik van deze reservering.",
      }),
      inputs: { booking: { type: "rent_reservations.Booking" } },
      read: false,
    },
    "rent_reservations.cancel_booking": {
      exported: true,
      handler: "cancel_booking",
      by: ["authenticated", "rent_reservations.reception"],
      label: message("Cancel booking", { nl: "Reservering annuleren" }),
      description: message(
        "Disable future admission while retaining physical possession and refund evidence.",
        {
          nl: "Blokkeer toekomstige toegang en behoud bewijs van werkelijk gebruik en terugbetaling.",
        },
      ),
      inputs: { booking: { type: "rent_reservations.Booking" }, reason: { type: "text" } },
      read: false,
    },
    "rent_fulfillment.request": {
      handler: "request",
      by: ["authenticated", "rent_reservations.reception"],
      label: message("Request payment and allowance", { nl: "Betaling en tegoed aanvragen" }),
      description: message("Ask the billing and allowance owners to reconcile the held booking.", {
        nl: "Vraag de facturatie- en tegoedeigenaren de tijdelijke reservering te reconciliëren.",
      }),
      inputs: {
        booking: { type: "rent_reservations.Booking" },
        use_allowance: {
          type: "bool",
          default: false,
          label: message("Use membership allowance", { nl: "Lidmaatschapstegoed gebruiken" }),
        },
      },
      read: false,
    },
    "rent_fulfillment.check_in": {
      handler: "check_in",
      by: "rent_reservations.reception",
      label: message("Check in", { nl: "Inchecken" }),
      description: message(
        "Check in only a currently fulfilled booking; physical occupancy lasts until checkout.",
        {
          nl: "Check alleen een momenteel voldane reservering in; werkelijk gebruik duurt tot het uitchecken.",
        },
      ),
      inputs: { booking: { type: "rent_reservations.Booking" } },
      read: false,
    },
    "rent_fulfillment.check_out": {
      handler: "check_out",
      by: "rent_reservations.reception",
      label: message("Check out", { nl: "Uitchecken" }),
      description: message("Record actual checkout rather than freeing an overrun by the clock.", {
        nl: "Leg werkelijk uitchecken vast in plaats van uitgelopen gebruik op basis van de klok vrij te geven.",
      }),
      inputs: { booking: { type: "rent_reservations.Booking" } },
      read: false,
    },
    "rent_fulfillment.cancel": {
      handler: "cancel",
      by: ["authenticated", "or", "rent_reservations.reception"],
      description: message(
        "Cancel future access and request the frozen-policy refund outcome separately.",
        {
          nl: "Annuleer toekomstige toegang en vraag afzonderlijk terugbetaling volgens de vastgelegde voorwaarden aan.",
        },
      ),
      inputs: { booking: { type: "rent_reservations.Booking" }, reason: { type: "text" } },
      read: false,
    },
    "rent_reservations.move_days": {
      description: message(
        "Move all local days in one transaction and retain the original on any conflict.",
        {
          nl: "Verplaats alle lokale dagen in één transactie en behoud bij elk conflict het origineel.",
        },
      ),
      handler: "move_days",
      exported: true,
      by: "authenticated",
      inputs: {
        booking: { type: "rent_reservations.Booking" },
        start: { type: "date" },
        end: { type: "date" },
      },
      label: message("Move workspace days", { nl: "Werkplekdagen verplaatsen" }),
      read: false,
    },
    "rent_reservations.revise_capacity": {
      description: message(
        "Change pooled capacity while preserving reservations and exposing every affected booking.",
        { nl: "Wijzig poolcapaciteit, behoud reserveringen en toon elke getroffen reservering." },
      ),
      handler: "revise_capacity",
      by: "rent_reservations.reservation_manager",
      inputs: {
        resource: { type: "rent_reservations.Resource" },
        capacity: { type: "int" },
        reason: { type: "text" },
      },
      label: message("Revise pooled capacity", { nl: "Poolcapaciteit herzien" }),
      read: false,
    },
    "rent_reservations.assign_desk": {
      description: message("Allocate a named desk inside this booking's existing pool quantity.", {
        nl: "Wijs een genoemd bureau toe binnen de bestaande poolhoeveelheid van deze reservering.",
      }),
      exported: true,
      handler: "assign_desk",
      by: "rent_reservations.reception",
      inputs: {
        booking: { type: "rent_reservations.Booking" },
        desk: { type: "rent_reservations.Desk" },
        from: { type: "datetime" },
        until: { type: "datetime" },
      },
      label: message("Assign pool desk", { nl: "Poolbureau toewijzen" }),
      read: false,
    },
    "rent_reservations.fulfill_free": {
      description: message(
        "Fulfill a zero-price hold explicitly without inventing paid provider evidence.",
        {
          nl: "Voldoe expliciet een gratis tijdelijke reservering zonder betaald providerbewijs te verzinnen.",
        },
      ),
      exported: true,
      handler: "fulfill_free",
      by: ["authenticated", "rent_reservations.reception"],
      inputs: { booking: { type: "rent_reservations.Booking" }, reason: { type: "text" } },
      label: message("Confirm free booking", { nl: "Gratis reservering bevestigen" }),
      read: false,
    },
    "rent_reservations.confirm_account": {
      description: message(
        "Confirm only finance-approved invoicing, retaining a real unpaid invoice obligation.",
        {
          nl: "Bevestig alleen financieel goedgekeurde facturatie en behoud een echte onbetaalde factuurverplichting.",
        },
      ),
      exported: true,
      handler: "confirm_account",
      by: ["rent_reservations.reception", "rent_reservations.billing"],
      inputs: { booking: { type: "rent_reservations.Booking" }, reason: { type: "text" } },
      label: message("Confirm on account", { nl: "Op rekening bevestigen" }),
      read: false,
    },
    "rent_reservations.no_show": {
      description: message(
        "Record missed arrival under the frozen terms without asserting physical departure.",
        {
          nl: "Leg gemiste aankomst vast onder de vastgelegde voorwaarden zonder werkelijk vertrek te veronderstellen.",
        },
      ),
      exported: true,
      handler: "no_show",
      by: "rent_reservations.reception",
      inputs: { booking: { type: "rent_reservations.Booking" }, reason: { type: "text" } },
      label: message("Record no-show", { nl: "Niet verschijnen vastleggen" }),
      read: false,
    },
    "rent_reservations.adjust": {
      description: message(
        "Keep overtime or damage charges separate from the original frozen booking price.",
        {
          nl: "Houd overuren- of schadebedragen gescheiden van de oorspronkelijke vastgelegde reserveringsprijs.",
        },
      ),
      handler: "adjust",
      by: "rent_reservations.billing",
      inputs: {
        booking: { type: "rent_reservations.Booking" },
        amount: { type: "money" },
        reason: { type: "text" },
      },
      label: message("Charge booking adjustment", { nl: "Reserveringscorrectie factureren" }),
      read: false,
    },
    "rent_reservations.refund_review": {
      description: message(
        "Resolve received funds with an explicit finance refund request and retained evidence.",
        {
          nl: "Los ontvangen geld op met een expliciete financiële terugbetalingsaanvraag en behouden bewijs.",
        },
      ),
      handler: "refund_review",
      by: "rent_reservations.billing",
      inputs: { booking: { type: "rent_reservations.Booking" }, reason: { type: "text" } },
      label: message("Refund booking exception", { nl: "Reserveringsuitzondering terugbetalen" }),
      read: false,
    },
    "rent_reservations.resolve_conflict": {
      description: message(
        "Mark a capacity conflict resolved only after the owner can honor or clear its booking.",
        {
          nl: "Markeer een capaciteitsconflict pas opgelost nadat de eigenaar de reservering kan nakomen of vrijgeven.",
        },
      ),
      handler: "resolve_conflict",
      by: "rent_reservations.reservation_manager",
      inputs: { conflict: { type: "rent_reservations.Conflict" }, evidence: { type: "text" } },
      label: message("Resolve reservation conflict", { nl: "Reserveringsconflict oplossen" }),
      read: false,
    },
    "rent_reservations.Desk.create": {
      handler: "createDesk",
      model: "rent_reservations.Desk",
      kind: "create",
      by: "rent_reservations.reservation_manager",
      inputs: { parent: { type: "rent_reservations.Resource" }, fields: ["name", "active"] },
      read: false,
      when: "Desk",
    },
    "rent_reservations.Desk.update": {
      handler: "updateDesk",
      model: "rent_reservations.Desk",
      kind: "update",
      by: "rent_reservations.reservation_manager",
      inputs: {
        record: { type: "rent_reservations.Desk" },
        changes: { fields: ["name", "active"] },
      },
      read: false,
      when: "Desk",
    },
  },
  handlers: {
    "rent_reservations.requested_affected": {
      handler: "requested_affected",
      on: { capability: "rent_reservations.RoomsIngressV1", event: "affected" },
    },
    "rent_reservations.movement_money": {
      handler: "movement_money",
      on: "rent_reservations.SettlementObserved",
    },
    "rent_reservations.movement_credit_money": {
      handler: "movement_credit_money",
      on: "rent_reservations.SettlementObserved",
    },
    "rent_reservations.movement_credit_result": {
      handler: "movement_credit_result",
      on: { capability: "rent_reservations.Billing", operation: "refund", event: "completed" },
    },
    "rent_reservations.movement_reserved": {
      handler: "movement_reserved",
      on: { capability: "rent_reservations.Membership", operation: "reserve", event: "completed" },
    },
    "rent_reservations.movement_committed": {
      handler: "movement_committed",
      on: { capability: "rent_reservations.Membership", operation: "commit", event: "completed" },
    },
    "rent_reservations.movement_changed": {
      handler: "movement_changed",
      on: { capability: "rent_reservations.Membership", event: "allowance_changed" },
    },
    "rent_reservations.movement_cancellation": {
      handler: "movement_cancellation",
      on: "rent_reservations.MovementCleared",
    },
    "rent_reservations.movement_result": {
      handler: "movement_result",
      on: "rent_reservations.MovementObserved",
    },
    "rent_reservations.movement_expire": {
      handler: "movement_expire",
      on: "rent_reservations.MovementDue",
    },
    "rent_reservations.movement_released": {
      handler: "movement_released",
      on: { capability: "rent_reservations.Membership", operation: "release", event: "completed" },
    },
    "rent_reservations.movement_reconciled": {
      handler: "movement_reconciled",
      on: {
        capability: "rent_reservations.Membership",
        operation: "reconcile",
        event: "completed",
      },
    },
    "rent_reservations.allowance_reconciled": {
      handler: "allowance_reconciled",
      on: {
        capability: "rent_reservations.Membership",
        operation: "reconcile",
        event: "completed",
      },
    },
    "rent_reservations.allowance_changed": {
      handler: "allowance_changed",
      on: { capability: "rent_reservations.Membership", event: "allowance_changed" },
    },
    "rent_reservations.allowance_snapshot": {
      handler: "allowance_snapshot",
      on: "rent_reservations.AllowanceObserved",
    },
    "rent_reservations.overdue_occupancy": {
      handler: "overdue_occupancy",
      on: "rent_reservations.OccupancyDue",
    },
    "rent_reservations.settlement_received": {
      handler: "settlement_received",
      on: { capability: "rent_reservations.Billing", event: "settled" },
    },
    "rent_reservations.reconciled": {
      handler: "reconciled",
      on: { capability: "rent_reservations.Billing", operation: "reconcile", event: "completed" },
    },
    "rent_reservations.venue_move": {
      handler: "venue_move",
      on: { capability: "rent_reservations.RoomsIngressV1", event: "move" },
    },
    "rent_reservations.requested_downtime": {
      handler: "requested_downtime",
      on: { capability: "rent_reservations.RoomsIngressV1", event: "downtime" },
    },
    "rent_reservations.requested_restore": {
      handler: "requested_restore",
      on: { capability: "rent_reservations.RoomsIngressV1", event: "restore" },
    },
    "rent_reservations.adjustment_money": {
      handler: "adjustment_money",
      on: "rent_reservations.SettlementObserved",
    },
    "rent_reservations.extension_expire": {
      handler: "extension_expire",
      on: "rent_reservations.AdjustmentDue",
    },
    "rent_reservations.quote_changed": {
      handler: "quote_changed",
      on: "rent_reservations.ReservationChanged",
    },
    "rent_reservations.charge_result": {
      handler: "charge_result",
      on: { capability: "rent_reservations.Billing", operation: "charge", event: "completed" },
    },
    "rent_reservations.venue_hold": {
      handler: "venue_hold",
      on: { capability: "rent_reservations.RoomsIngressV1", event: "hold" },
    },
    "rent_reservations.venue_stage": {
      handler: "venue_stage",
      on: { capability: "rent_reservations.RoomsIngressV1", event: "stage" },
    },
    "rent_reservations.venue_confirm": {
      handler: "venue_confirm",
      on: { capability: "rent_reservations.RoomsIngressV1", event: "confirm" },
    },
    "rent_reservations.venue_release": {
      handler: "venue_release",
      on: { capability: "rent_reservations.RoomsIngressV1", event: "release" },
    },
    "rent_reservations.quote_hold": {
      handler: "quote_hold",
      on: { capability: "rent_reservations.RoomsIngressV1", event: "hold_offer" },
    },
    "rent_reservations.quote_accept": {
      handler: "quote_accept",
      on: { capability: "rent_reservations.RoomsIngressV1", event: "accept_offer" },
    },
    "rent_reservations.quote_release": {
      handler: "quote_release",
      on: { capability: "rent_reservations.RoomsIngressV1", event: "release_offer" },
    },
    "rent_reservations.venue_expire": { handler: "venue_expire", on: "rent_reservations.VenueDue" },
    "rent_reservations.quote_expire": { handler: "quote_expire", on: "rent_reservations.QuoteDue" },
    "rent_reservations.allowance_result": {
      handler: "allowance_result",
      on: { capability: "rent_reservations.Membership", operation: "reserve", event: "completed" },
    },
    "rent_reservations.money": { handler: "money", on: "rent_reservations.SettlementObserved" },
    "rent_reservations.consumption": {
      handler: "consumption",
      on: { capability: "rent_reservations.Membership", operation: "consume", event: "completed" },
    },
    "rent_reservations.expire": { handler: "expire", on: "rent_reservations.HoldDue" },
    "rent_reservations.commercial_changed": {
      handler: "commercial_changed",
      on: "rent_reservations.ReservationChanged",
    },
    "rent_reservations.commercial_check": {
      handler: "commercial_check",
      on: "rent_reservations.CommercialCheck",
    },
    "rent_reservations.correspondence": {
      handler: "correspondence",
      on: "rent_reservations.ReservationChanged",
    },
    "rent_reservations.remind": { handler: "remind", on: "rent_reservations.Reminder" },
    "rent_reservations.released": {
      handler: "released",
      on: { capability: "rent_reservations.Membership", operation: "release", event: "completed" },
    },
    "rent_reservations.refund_result": {
      handler: "refund_result",
      on: { capability: "rent_reservations.Billing", operation: "refund", event: "completed" },
    },
    "rent_reservations.snapshot_Resource_create": {
      handler: "snapshot_Resource_create",
      on: "rent_reservations.Resource.create",
      kind: "hook",
    },
    "rent_reservations.snapshot_Resource_update": {
      handler: "snapshot_Resource_update",
      on: "rent_reservations.Resource.update",
      kind: "hook",
    },
    "rent_reservations.snapshot_Window_create": {
      handler: "snapshot_Window_create",
      on: "rent_reservations.Window.create",
      kind: "hook",
    },
    "rent_reservations.snapshot_Window_update": {
      handler: "snapshot_Window_update",
      on: "rent_reservations.Window.update",
      kind: "hook",
    },
    "rent_reservations.snapshot_DayCalendar_create": {
      handler: "snapshot_DayCalendar_create",
      on: "rent_reservations.DayCalendar.create",
      kind: "hook",
    },
    "rent_reservations.snapshot_DayCalendar_update": {
      handler: "snapshot_DayCalendar_update",
      on: "rent_reservations.DayCalendar.update",
      kind: "hook",
    },
  },
  pages: [
    workspaceCatalogPageDescriptor,
    bookingHistoryPageDescriptor,
    financeReviewPageDescriptor,
    resourceCatalogPageDescriptor,
    workspacePageDescriptor,
    reservationsPageDescriptor,
    myBookingsPageDescriptor,
    arrivalsPageDescriptor,
    occupancyPageDescriptor,
  ],
  disabled: [
    "rent_reservations.Resource.delete",
    "rent_reservations.Window.delete",
    "rent_reservations.Booking.create",
    "rent_reservations.Downtime.create",
    "rent_reservations.Booking.update",
    "rent_reservations.Downtime.update",
    "rent_reservations.Booking.delete",
    "rent_reservations.Downtime.delete",
  ],
};

export function canApp() {
  const crudWhen = {
    Resource: async (c, row) => await can_work(c, c.actor, row.location),
    Window: async (c, row) => await can_work(c, c.actor, row.parent.location),
    DayCalendar: async (c, row) => await can_work(c, c.actor, row.parent.location),
    Desk: async (c, row) => await can_work(c, c.actor, row.parent.location),
  };
  return {
    async retain_legacy(c,{source,external_id,location,facts,source_evidence,attestation}) {
      check(hasRole(c,reservation_manager),"forbidden");
      check(await can_work(c,c.actor,location) && source.trim()!=="" && external_id.trim()!=="" && attestation.trim()!=="");
      check(!await any(records(c,LegacyBooking,{archived:"include"}),entry=>entry.source===source.trim() && entry.external_id===external_id));
      return create(c,LegacyBooking,{source:source.trim(),external_id,location,facts,source_evidence,attestation:attestation.trim()});
    },
    async legacy_matches(c,{source,external_id,location}) {
      check(hasRole(c,"authenticated"),"forbidden");
      return collect(records(c,LegacyBooking,{archived:"include",where:entry=>entry.source===source.trim() && entry.external_id===external_id && same(entry.location,location)}));
    },
    async link_legacy(c,{entry,customer,resource,account,reason}) {
      check(hasRole(c,reservation_manager)||hasRole(c,"invoice.finance"),"forbidden");
      check(await can_work(c,c.actor,entry.location) && reason.trim()!=="");
      check(customer===null || hasRole(c,"invoice.finance") && (entry.facts.customer_source??"").trim()!=="" && (entry.facts.customer_external_id??"").trim()!=="" && customer.locations.some(location=>same(location,entry.location)));
      check(resource===null || hasRole(c,reservation_manager) && (entry.facts.resource_source??"").trim()!=="" && (entry.facts.resource_external_id??"").trim()!=="" && same(resource.location,entry.location));
      check(account===null || customer!==null && (await owns(c,account,customer) || await has_location_role(c,account,customer,"booker",entry.location)));
      await set(c,entry,{customer,resource,account,mapping_reason:reason.trim()});
    },
    can_read_booking_details,
    may_reserve,
    may_move,
    commercial,
    quote_covers,
    quote_available,
    next_boundary,
    financial_cover,
    credit_baseline,
    movement_busy,
    movement_covers,
    movement_request,
    benefit_request,
    charge_request,
    free_at,
    crudWhen,

    resource_evidence,
    saved_service,
    saved_saleable,
    saved_rows,
    read: {
      "LegacyBooking.read.1":async(c,row)=>(hasRole(c,reservation_manager)||hasRole(c,"invoice.finance")) && await can_work(c,c.actor,row.location),
      "LegacyBooking.read.2":async(c,row)=>hasRole(c,"authenticated") && same(row.account,c.actor) && row.customer!==null && (await owns(c,c.actor,row.customer) || await has_location_role(c,c.actor,row.customer,"booker",row.location)),
      "ResourcePolicy.read.1": async (c, row) =>
        hasRole(c, "rent_reservations.reservation_manager") &&
        (await can_work(c, c.actor, row.parent.location)),
      "Resource.read.1": () => true,
      "MovementCredit.read.2": (c, row) =>
        hasRole(c, "authenticated") && same(row.parent.parent.account, c.actor),
      "MovementCredit.read.1": async (c, row) =>
        hasRole(c, "rent_reservations.billing") &&
        (await can_work(c, c.actor, row.parent.parent.parent.location)),
      "Notice.read.1": (c, row) => hasRole(c, "authenticated") && same(row.parent.account, c.actor),
      "Notice.read.2": async (c, row) =>
        hasRole(c, "rent_reservations.reception") &&
        (await can_work(c, c.actor, row.parent.parent.location)),
      "Movement.read.1": (c, row) =>
        hasRole(c, "authenticated") && same(row.parent.account, c.actor),
      "Movement.read.3": async (c, row) =>
        hasRole(c, "rent_reservations.billing") &&
        (await can_work(c, c.actor, row.parent.parent.location)),
      "Movement.read.2": async (c, row) =>
        hasRole(c, "rent_reservations.reservation_manager") &&
        (await can_work(c, c.actor, row.parent.parent.location)),
      "Resource.read.2": async (c, row) =>
        hasRole(c, catalog_owner) && (await can_work(c, c.actor, row.location)),
      "Resource.read.3": async (c, row) =>
        hasRole(c, "rent_reservations.reservation_manager") &&
        (await can_work(c, c.actor, row.location)),
      "Window.read.1": () => true,
      "DayCalendar.read.1": () => true,
      "Desk.read.1": () => true,
      "CapacityRevision.read.1": async (c, row) =>
        hasRole(c, "rent_reservations.reservation_manager") &&
        (await can_work(c, c.actor, row.parent.location)),
      "Conflict.read.1": async (c, row) =>
        hasRole(c, "rent_reservations.reservation_manager") &&
        (await can_work(c, c.actor, row.parent.location)),
      "DowntimeFence.read.1": async (c, row) =>
        hasRole(c, "rent_reservations.reservation_manager") &&
        (await can_work(c, c.actor, row.parent.location)),
      "VenueFence.read.1": async (c, row) =>
        hasRole(c, "rent_reservations.reservation_manager") &&
        (await can_work(c, c.actor, row.parent.location)),
      "ReservationFence.read.1": async (c, row) =>
        hasRole(c, "rent_reservations.reservation_manager") &&
        (await can_work(c, c.actor, row.parent.location)),
      "QuoteHold.read.1": async (c, row) =>
        hasRole(c, "rent_reservations.reservation_manager") &&
        (await can_work(c, c.actor, row.parent.location)),
      "VenueReservation.read.1": async (c, row) =>
        hasRole(c, "rent_reservations.reservation_manager") &&
        (await can_work(c, c.actor, row.parent.location)),
      "VenueReservation.read.2": async (c, row) =>
        hasRole(c, "rent_reservations.reception") &&
        (await can_work(c, c.actor, row.parent.location)),
      "VenueReservation.read.3": (c, row) =>
        hasRole(c, "authenticated") && same(row.account, c.actor),
      "Assignment.read.1": async (c, row) =>
        hasRole(c, "rent_reservations.reception") &&
        (await can_work(c, c.actor, row.parent.parent.location)),
      "Assignment.read.2": (c, row) =>
        hasRole(c, "authenticated") && same(row.parent.account, c.actor),
      "Adjustment.read.1": async (c, row) =>
        hasRole(c, "rent_reservations.billing") &&
        (await can_work(c, c.actor, row.parent.parent.location)),
      "Adjustment.read.2": (c, row) =>
        hasRole(c, "authenticated") && same(row.parent.account, c.actor),
      "Booking.read.1": can_read_booking_details,
      "Booking.read.2": async (c, row) =>
        hasRole(c, "rent_reservations.reception") &&
        (await can_work(c, c.actor, row.parent.location)),
      "Downtime.read.1": async (c, row) =>
        hasRole(c, "rent_reservations.reservation_manager") &&
        (await can_work(c, c.actor, row.parent.location)),
    },
    invariants: {
      "LegacyBooking.invariant.1":(c,row)=>(row.facts.customer_source===null)===(row.facts.customer_external_id===null) && (row.facts.resource_source===null)===(row.facts.resource_external_id===null),
      "DayCalendar.require.1": (c, row) =>
        compareInstant(
          local_instant(row.day, row.opens, row.parent.timezone, { fold: row.fold }),
          local_instant(row.day, row.closes, row.parent.timezone, { fold: row.fold }),
        ) < 0,
      "Assignment.require.1": (c, row) =>
        compareInstant(row.from, row.until) < 0 &&
        compareInstant(row.parent.from, row.from) <= 0 &&
        compareInstant(row.until, row.parent.until) <= 0 &&
        same(row.desk.parent, row.parent.parent),
      "Movement.require.1": (c, row) =>
        row.intervals.every((interval) => compareInstant(interval.from, interval.until) < 0),
      "Adjustment.require.1": (c, row) =>
        row.amount.currency === row.parent.total.currency && row.amount.minor > 0n,
      "VenueReservation.require.1": (c, row) =>
        compareInstant(row.from, row.until) < 0 &&
        row.quantity > 0n &&
        (row.previous === null ||
          (same(row.previous.parent, row.parent) && row.quantity === row.previous.quantity)),
      "QuoteHold.require.1": (c, row) =>
        compareInstant(row.from, row.until) < 0 &&
        row.quantity > 0n &&
        compareInstant(row.expires, row.offer.snapshot.expires) <= 0,
      "Resource.require.1": (c, row) =>
        row.currency === row.location.currency && row.timezone === row.location.timezone,
      "Resource.require.2": (c, row) =>
        row.hourly.currency === row.currency &&
        row.hourly.minor >= 0n &&
        row.increment > 0n &&
        row.minimum > 0n &&
        row.refund_notice >= 0n &&
        (row.cancellation_fee === null ||
          (row.cancellation_fee.currency === row.currency && row.cancellation_fee.minor >= 0n)) &&
        (row.daily === null || (row.daily.currency === row.currency && row.daily.minor >= 0n)) &&
        (row.price_unit !== "day" || row.daily !== null) &&
        row.hold_for > 0n &&
        row.buffer_before >= 0n &&
        row.buffer_after >= 0n &&
        (row.pooled || row.capacity === 1n),
      "Window.require.1": (c, row) => compareInstant(row.from, row.until) < 0,
      "Booking.require.1": (c, row) =>
        compareInstant(row.from, row.until) < 0 &&
        compareInstant(row.reserved_from, row.from) <= 0 &&
        compareInstant(row.until, row.reserved_until) <= 0 &&
        row.total.currency === row.parent.currency &&
        row.total.minor >= 0n &&
        equalMoney(row.total, addMoney(subtractMoney(row.subtotal, row.discount), row.tax)) &&
        row.tax.minor >= 0n &&
        row.discount.minor >= 0n &&
        compareMoney(row.discount, addMoney(row.subtotal, row.tax)) <= 0 &&
        row.refund_amount.currency === row.total.currency &&
        row.refund_amount.minor >= 0n &&
        compareMoney(row.refund_amount, row.total) <= 0 &&
        row.intervals.every(
          (interval) =>
            compareInstant(interval.from, interval.until) < 0 &&
            compareInstant(row.reserved_from, interval.from) <= 0 &&
            compareInstant(interval.until, row.reserved_until) <= 0,
        ),
    },
    locks: {
      "ReservationFence.lock.1": { fields: ["source", "revision", "reason", "offer"] },
      "LegacyBooking.lock.1":{fields:["source","external_id","location","facts","source_evidence","attestation","imported_by","imported_at"]},
      "ResourcePolicy.lock.1": { fields: ["effective", "sequence", "value"] },
      "Booking.lock.2": { fields: ["monetary_due"], when: (c, row) => row.monetary_due !== null },
      "Booking.lock.1": {
        fields: [
          "billing_location",
          "sale_product",
          "purchased_at",
          "attribution",
          "exclusive_program",
          "attributed_at",
          "attribution_window",
          "customer",
          "account",
          "rate",
          "tax_fraction",
          "discount_fraction",
          "subtotal",
          "tax",
          "discount",
          "total",
          "refund_amount",
          "terms",
          "refund_before",
          "source",
          "departure_buffer",
          "arrival_buffer",
          "benefit_intervals",
          "benefit_rate",
          "benefit_unit",
          "benefit_duration",
          "original_intervals",
          "quote",
        ],
      },
    },
    derives: {
      "Notice.state": async (c, row) =>
        (await delivery(c, { record: row, field: "delivery" }, ["status"])).status,
    },
    busy,
    covers,
    free,
    bookable,
    credit_allowed,
    venue_busy,
    venue_covers,
    async snapshot_Resource_create(c, { event }) {
      const resource = event.after;
      await create(c, "rent_reservations.ResourcePolicy", {
        parent: resource,
        sequence: int64(
          (await count(records(c, "rent_reservations.ResourcePolicy", { parent: resource }))) + 1n,
        ),
        value: await resource_evidence(c, resource),
      });
    },
    async snapshot_Resource_update(c, { event }) {
      const resource = event.after;
      await create(c, "rent_reservations.ResourcePolicy", {
        parent: resource,
        sequence: int64(
          (await count(records(c, "rent_reservations.ResourcePolicy", { parent: resource }))) + 1n,
        ),
        value: await resource_evidence(c, resource),
      });
    },
    async snapshot_Window_create(c, { event }) {
      const resource = event.after.parent;
      await create(c, "rent_reservations.ResourcePolicy", {
        parent: resource,
        sequence: int64(
          (await count(records(c, "rent_reservations.ResourcePolicy", { parent: resource }))) + 1n,
        ),
        value: await resource_evidence(c, resource),
      });
    },
    async snapshot_Window_update(c, { event }) {
      const resource = event.after.parent;
      await create(c, "rent_reservations.ResourcePolicy", {
        parent: resource,
        sequence: int64(
          (await count(records(c, "rent_reservations.ResourcePolicy", { parent: resource }))) + 1n,
        ),
        value: await resource_evidence(c, resource),
      });
    },
    async snapshot_DayCalendar_create(c, { event }) {
      const resource = event.after.parent;
      await create(c, "rent_reservations.ResourcePolicy", {
        parent: resource,
        sequence: int64(
          (await count(records(c, "rent_reservations.ResourcePolicy", { parent: resource }))) + 1n,
        ),
        value: await resource_evidence(c, resource),
      });
    },
    async snapshot_DayCalendar_update(c, { event }) {
      const resource = event.after.parent;
      await create(c, "rent_reservations.ResourcePolicy", {
        parent: resource,
        sequence: int64(
          (await count(records(c, "rent_reservations.ResourcePolicy", { parent: resource }))) + 1n,
        ),
        value: await resource_evidence(c, resource),
      });
    },
    async createResource(c, input) {
      check(hasRole(c, catalog_owner), "forbidden");
      await create(c, "rent_reservations.Resource", input, { when: crudWhen.Resource });
    },
    async updateResource(c, { record, changes }) {
      check(hasRole(c, catalog_owner), "forbidden");
      await set(c, record, changes, { when: crudWhen.Resource });
    },
    async createWindow(c, input) {
      check(hasRole(c, "rent_reservations.reservation_manager"), "forbidden");
      await create(c, "rent_reservations.Window", input, { when: crudWhen.Window });
    },
    async updateWindow(c, { record, changes }) {
      check(hasRole(c, "rent_reservations.reservation_manager"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Window });
    },
    async resource_report(c, { resource, from, until }) {
      check(hasRole(c, "rent_reservations.reservation_manager"), "forbidden");
      check((await can_work(c, c.actor, resource.location)) && compareInstant(from, until) < 0);
      const days = dates(
          add_days(local_date(from, resource.timezone), -1n),
          add_days(local_date(until, resource.timezone), 1n),
          1000n,
        ),
        policies = await collect(
          records(c, "rent_reservations.ResourcePolicy", { parent: resource }),
        ),
        openings = await collect(
          records(c, "rent_catalog.LocationPolicy", { parent: resource.location }),
        );
      const weekly = flatten(
        flatten(
          openings.map((policy) =>
            flatten(
              days.map((day) =>
                policy.weekly
                  .filter((hours) => weekday(day) === hours.weekday)
                  .map((hours) => [
                    local_instant(day, hours.opens, policy.timezone, { fold: hours.fold }),
                    local_instant(add_days(day, hours.close_after), hours.closes, policy.timezone, {
                      fold: hours.fold,
                    }),
                  ]),
              ),
            ),
          ),
        ),
      );
      const dated = flatten(
        flatten(
          openings.map((policy) =>
            policy.dated
              .filter((hours) => !hours.closed)
              .map((hours) => [
                local_instant(hours.day, hours.opens, policy.timezone, { fold: hours.fold }),
                local_instant(
                  add_days(hours.day, hours.close_after),
                  hours.closes,
                  policy.timezone,
                  { fold: hours.fold },
                ),
              ]),
          ),
        ),
      );
      const midnight = days.map((day) =>
          local_instant(day, "00:00", resource.timezone, { fold: "earlier" }),
        ),
        windows = flatten(
          flatten(
            policies.map((policy) =>
              policy.value.windows.map((window) => [window.from, window.until]),
            ),
          ),
        ),
        downtime = flatten(
          flatten(
            policies.map((policy) =>
              policy.value.downtime.map((downtime) => [downtime.from, downtime.until ?? until]),
            ),
          ),
        ),
        service = flatten(
          flatten(
            policies.map((policy) =>
              policy.value.bookings.map((booking) => [
                booking.from,
                booking.until,
                booking.checked_in ?? from,
                booking.checked_out ?? c.now,
              ]),
            ),
          ),
        ),
        access = flatten(
          flatten(
            policies.map((policy) =>
              policy.value.bookings.map((booking) =>
                flatten(
                  booking.intervals.map((interval) => [
                    addDuration(interval.from, booking.arrival_buffer),
                    subtractDuration(interval.until, booking.departure_buffer),
                  ]),
                ),
              ),
            ),
          ),
        ),
        venues = flatten(
          flatten(
            policies.map((policy) => policy.value.venues.map((venue) => [venue.from, venue.until])),
          ),
        );
      const boundaries = [
          from,
          until,
          ...weekly,
          ...dated,
          ...midnight,
          ...windows,
          ...downtime,
          ...service,
          ...access,
          ...venues,
          ...policies.map((policy) => policy.effective),
          ...openings.map((policy) => policy.effective),
        ],
        points = (
          await group(
            boundaries.filter(
              (point) => compareInstant(from, point) <= 0 && compareInstant(point, until) <= 0,
            ),
            (point) => point,
          )
        )
          .map((point) => point.key)
          .sort(compareInstant);
      const complete =
          (await any(policies, (policy) => compareInstant(policy.effective, from) <= 0)) &&
          (await any(openings, (policy) => compareInstant(policy.effective, from) <= 0)),
        stamp =
          policies
            .sort((a, b) => (a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0))
            .map((policy) =>
              format("{id}:{sequence}", { id: policy.id, sequence: policy.sequence }),
            )
            .join(",") +
          ":" +
          openings
            .sort((a, b) => (a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0))
            .map((policy) =>
              format("{id}:{sequence}", { id: policy.id, sequence: policy.sequence }),
            )
            .join(",");
      return {
        checkpoint: {
          source: resource.id,
          revision: stamp,
          generated: c.now,
          state: complete ? "fresh" : "partial",
          complete,
        },
        rows: await saved_rows(c, resource, points, until),
      };
    },
    async available(c, { resource, from, until, quantity = 1n, attendees = 1n, amenities = [] }) {
      check(hasRole(c, "public"), "forbidden");
      check(
        resource.price_unit === "hour" &&
          compareInstant(c.now, from) <= 0 &&
          compareInstant(from, until) < 0 &&
          quantity > 0n &&
          attendees > 0n,
      );
      const subtotal = multiplyMoney(
          multiplyMoney(resource.hourly, divideDecimal(durationBetween(until, from), 3600000n)),
          quantity,
        ),
        discounted = subtractMoney(subtotal, multiplyMoney(subtotal, resource.discount_rate));
      return {
        resource,
        from,
        until,
        quantity,
        attendees,
        available:
          attendees <= resource.party_limit &&
          (!resource.pooled || attendees <= quantity) &&
          durationBetween(until, from) >= resource.minimum &&
          durationBetween(until, from) % resource.increment === 0n &&
          amenities.every((amenity) => resource.amenities.includes(amenity)) &&
          (await free(
            c,
            resource,
            subtractDuration(from, resource.buffer_before),
            addDuration(until, resource.buffer_after),
            quantity,
            null,
          )),
        total: addMoney(discounted, multiplyMoney(discounted, resource.tax_rate)),
        terms: resource.terms,
        refund_before: subtractDuration(from, resource.refund_notice),
      };
    },
    async available_days(
      c,
      { resource, start, end, quantity = 1n, attendees = 1n, amenities = [] },
    ) {
      check(hasRole(c, "public"), "forbidden");
      check(
        resource.price_unit === "day" &&
          resource.daily !== null &&
          compareDate(start, end) < 0 &&
          quantity > 0n &&
          attendees > 0n,
      );
      const access = [];
      for await (const day of records(c, "rent_reservations.DayCalendar", {
        parent: resource,
        where: (d) => compareDate(start, d.day) <= 0 && compareDate(d.day, end) < 0 && !d.closed,
      }))
        access.push({
          from: subtractDuration(
            local_instant(day.day, day.opens, resource.timezone, { fold: day.fold }),
            resource.buffer_before,
          ),
          until: addDuration(
            local_instant(day.day, day.closes, resource.timezone, { fold: day.fold }),
            resource.buffer_after,
          ),
        });
      const required = await count(dates(start, end, 1000n)),
        actual = await count(access);
      const subtotal = multiplyMoney(multiplyMoney(resource.daily, required), quantity),
        discounted = subtractMoney(subtotal, multiplyMoney(subtotal, resource.discount_rate));
      let available =
        attendees <= resource.party_limit &&
        (!resource.pooled || attendees <= quantity) &&
        amenities.every((amenity) => resource.amenities.includes(amenity)) &&
        actual === required &&
        actual > 0n;
      for (const interval of access)
        if (
          !(
            compareInstant(c.now, interval.from) <= 0 &&
            (await free(c, resource, interval.from, interval.until, quantity, null))
          )
        )
          available = false;
      return {
        resource,
        start,
        end,
        quantity,
        attendees,
        available,
        total: addMoney(discounted, multiplyMoney(discounted, resource.tax_rate)),
        terms: resource.terms,
      };
    },
    async hold(
      c,
      {
        resource,
        customer,
        from,
        until,
        quantity,
        email,
        account = null,
        attendees = 1n,
        capture = null,
        use_allowance = false,
      },
    ) {
      check(hasRole(c, "authenticated") || hasRole(c, "rent_reservations.reception"), "forbidden");
      check(
        capture === null ||
          (c.actor.email_verified &&
            same(capture.parent, customer) &&
            same(capture.account, account ?? c.actor) &&
            same(capture.account, c.actor) &&
            same(
              capture,
              await latest_capture(
                c,
                customer,
                c.actor,
                resource.location,
                format(
                  c,
                  message(
                    "{kind}",
                    {},
                    { kind: { type: "rent_reservations.Resource.kind", value: resource.kind } },
                  ),
                  { locale: null },
                ),
              ),
            )),
      );
      check(
        c.actor.email_verified &&
          customer.active &&
          customer.locations.some((location) => same(location, resource.location)),
      );
      check(
        account === null ||
          (hasRole(c, "rent_reservations.reception") &&
            (await can_work(c, c.actor, resource.location)) &&
            ((customer.kind === "individual" && (await owns(c, account, customer))) ||
              (await has_location_role(c, account, customer, "booker", resource.location)) ||
              (await has_location_role(c, account, customer, "administrator", resource.location)))),
      );
      check(
        (account !== null &&
          hasRole(c, "rent_reservations.reception") &&
          (await can_work(c, c.actor, resource.location))) ||
          (hasRole(c, "rent_reservations.reservation_manager") &&
            (await can_work(c, c.actor, resource.location))) ||
          (customer.kind === "individual" && (await owns(c, c.actor, customer))) ||
          (await has_location_role(c, c.actor, customer, "booker", resource.location)) ||
          (await has_location_role(c, c.actor, customer, "administrator", resource.location)),
      );
      check(
        resource.price_unit === "hour" &&
          attendees > 0n &&
          attendees <= resource.party_limit &&
          (!resource.pooled || attendees <= quantity) &&
          compareInstant(from, c.now) >= 0 &&
          compareInstant(from, until) < 0 &&
          quantity > 0n &&
          durationBetween(until, from) >= resource.minimum &&
          durationBetween(until, from) % resource.increment === 0n,
      );
      check(
        await free(
          c,
          resource,
          subtractDuration(from, resource.buffer_before),
          addDuration(until, resource.buffer_after),
          quantity,
          null,
        ),
      );
      const subtotal = multiplyMoney(
        multiplyMoney(resource.hourly, divideDecimal(durationBetween(until, from), 3600000n)),
        quantity,
      );
      const discount = multiplyMoney(subtotal, resource.discount_rate),
        tax = multiplyMoney(subtractMoney(subtotal, discount), resource.tax_rate),
        total = addMoney(subtractMoney(subtotal, discount), tax);
      const booking = await create(c, "rent_reservations.Booking", {
        parent: resource,
        billing_location: resource.location,
        sale_product: format(
          c,
          message(
            "{kind}",
            {},
            { kind: { type: "rent_reservations.Resource.kind", value: resource.kind } },
          ),
          { locale: null },
        ),
        purchased_at: c.now,
        attribution: capture?.code ?? null,
        exclusive_program: capture?.program ?? null,
        attributed_at: capture?.captured ?? null,
        attribution_window: capture?.window ?? null,
        customer,
        account: account ?? c.actor,
        email,
        from,
        until,
        quantity,
        attendees,
        rate: resource.hourly,
        tax_fraction: resource.tax_rate,
        discount_fraction: resource.discount_rate,
        subtotal,
        discount,
        tax,
        total,
        refund_amount: max([
          money(0n, resource.currency),
          subtractMoney(total, resource.cancellation_fee ?? money(0n, resource.currency)),
        ]),
        terms: resource.terms,
        refund_before: subtractDuration(from, resource.refund_notice),
        reserved_from: subtractDuration(from, resource.buffer_before),
        reserved_until: addDuration(until, resource.buffer_after),
        expires: addDuration(c.now, resource.hold_for),
        source: c.operation.id,
        departure_buffer: resource.buffer_after,
        arrival_buffer: resource.buffer_before,
        benefit_unit: resource.price_unit,
        benefit_duration: resource.increment,
        benefit_rate: multiplyMoney(resource.hourly, divideDecimal(resource.increment, 3600000n)),
        benefit_intervals: [{ from, until }],
      });
      await create(c, "rent_reservations.ResourcePolicy", {
        parent: booking.parent,
        sequence: int64(
          (await count(
            records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
          )) + 1n,
        ),
        value: await resource_evidence(c, booking.parent),
      });
      if (use_allowance) await set(c, booking, { allowance: "pending" });
      await schedule(c, booking.id, booking.expires, "rent_reservations.HoldDue", { booking });
      await emit(c, "rent_reservations.ReservationChanged", { booking, revision: booking.version });
      return booking;
    },
    async hold_days(
      c,
      {
        resource,
        customer,
        start,
        end,
        quantity,
        email,
        account = null,
        attendees = 1n,
        capture = null,
        use_allowance = false,
      },
    ) {
      check(hasRole(c, "authenticated") || hasRole(c, "rent_reservations.reception"), "forbidden");
      check(
        capture === null ||
          (c.actor.email_verified &&
            same(capture.parent, customer) &&
            same(capture.account, account ?? c.actor) &&
            same(capture.account, c.actor) &&
            same(
              capture,
              await latest_capture(
                c,
                customer,
                c.actor,
                resource.location,
                format(
                  c,
                  message(
                    "{kind}",
                    {},
                    { kind: { type: "rent_reservations.Resource.kind", value: resource.kind } },
                  ),
                  { locale: null },
                ),
              ),
            )),
      );
      check(
        c.actor.email_verified &&
          customer.active &&
          customer.locations.some((location) => same(location, resource.location)),
      );
      check(
        account === null ||
          (hasRole(c, "rent_reservations.reception") &&
            (await can_work(c, c.actor, resource.location)) &&
            ((customer.kind === "individual" && (await owns(c, account, customer))) ||
              (await has_location_role(c, account, customer, "booker", resource.location)) ||
              (await has_location_role(c, account, customer, "administrator", resource.location)))),
      );
      check(
        (account !== null &&
          hasRole(c, "rent_reservations.reception") &&
          (await can_work(c, c.actor, resource.location))) ||
          (hasRole(c, "rent_reservations.reservation_manager") &&
            (await can_work(c, c.actor, resource.location))) ||
          (customer.kind === "individual" && (await owns(c, c.actor, customer))) ||
          (await has_location_role(c, c.actor, customer, "booker", resource.location)) ||
          (await has_location_role(c, c.actor, customer, "administrator", resource.location)),
      );
      check(
        resource.price_unit === "day" &&
          resource.daily !== null &&
          compareDate(start, end) < 0 &&
          quantity > 0n &&
          attendees > 0n &&
          attendees <= resource.party_limit &&
          (!resource.pooled || attendees <= quantity),
      );
      const days = [];
      for await (const day of records(c, "rent_reservations.DayCalendar", {
        parent: resource,
        where: (d) => compareDate(start, d.day) <= 0 && compareDate(d.day, end) < 0 && !d.closed,
      }))
        days.push(day);
      days.sort((a, b) => compareDate(a.day, b.day));
      const access = [];
      let dayCount = 0n;
      for (const day of days) {
        access.push({
          from: subtractDuration(
            local_instant(day.day, day.opens, resource.timezone, { fold: day.fold }),
            resource.buffer_before,
          ),
          until: addDuration(
            local_instant(day.day, day.closes, resource.timezone, { fold: day.fold }),
            resource.buffer_after,
          ),
        });
        dayCount = int64(dayCount + 1n);
      }
      const required = await count(dates(start, end, 1000n));
      check(dayCount === required && dayCount > 0n);
      for (const interval of access)
        check(
          compareInstant(c.now, interval.from) <= 0 &&
            (await free(c, resource, interval.from, interval.until, quantity, null)),
        );
      const first = at(access, 0n),
        last = at(access, dayCount - 1n);
      const subtotal = multiplyMoney(multiplyMoney(resource.daily, dayCount), quantity),
        discount = multiplyMoney(subtotal, resource.discount_rate),
        tax = multiplyMoney(subtractMoney(subtotal, discount), resource.tax_rate),
        total = addMoney(subtractMoney(subtotal, discount), tax);
      const booking = await create(c, "rent_reservations.Booking", {
        parent: resource,
        billing_location: resource.location,
        sale_product: format(
          c,
          message(
            "{kind}",
            {},
            { kind: { type: "rent_reservations.Resource.kind", value: resource.kind } },
          ),
          { locale: null },
        ),
        purchased_at: c.now,
        attribution: capture?.code ?? null,
        exclusive_program: capture?.program ?? null,
        attributed_at: capture?.captured ?? null,
        attribution_window: capture?.window ?? null,
        customer,
        account: account ?? c.actor,
        email,
        from: addDuration(first.from, resource.buffer_before),
        until: subtractDuration(last.until, resource.buffer_after),
        intervals: access,
        original_intervals: access,
        benefit_unit: "day",
        benefit_duration: 86400000n,
        benefit_rate: resource.daily,
        benefit_intervals: access.map((interval) => ({
          from: addDuration(interval.from, resource.buffer_before),
          until: subtractDuration(interval.until, resource.buffer_after),
        })),
        quantity,
        attendees,
        rate: resource.daily,
        tax_fraction: resource.tax_rate,
        discount_fraction: resource.discount_rate,
        subtotal,
        discount,
        tax,
        total,
        refund_amount: max([
          money(0n, resource.currency),
          subtractMoney(total, resource.cancellation_fee ?? money(0n, resource.currency)),
        ]),
        terms: resource.terms,
        refund_before: subtractDuration(
          addDuration(first.from, resource.buffer_before),
          resource.refund_notice,
        ),
        reserved_from: first.from,
        reserved_until: last.until,
        expires: addDuration(c.now, resource.hold_for),
        source: c.operation.id,
        departure_buffer: resource.buffer_after,
        arrival_buffer: resource.buffer_before,
      });
      await create(c, "rent_reservations.ResourcePolicy", {
        parent: booking.parent,
        sequence: int64(
          (await count(
            records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
          )) + 1n,
        ),
        value: await resource_evidence(c, booking.parent),
      });
      if (use_allowance) await set(c, booking, { allowance: "pending" });
      await schedule(c, booking.id, booking.expires, "rent_reservations.HoldDue", { booking });
      await emit(c, "rent_reservations.ReservationChanged", { booking, revision: booking.version });
      return booking;
    },
    async createDayCalendar(c, input) {
      check(hasRole(c, "rent_reservations.reservation_manager"), "forbidden");
      await create(c, "rent_reservations.DayCalendar", input, { when: crudWhen.DayCalendar });
    },
    async updateDayCalendar(c, { record, changes }) {
      check(hasRole(c, "rent_reservations.reservation_manager"), "forbidden");
      await set(c, record, changes, { when: crudWhen.DayCalendar });
    },
    async move(c, { booking, from, until }) {
      check(hasRole(c, "authenticated"), "forbidden");
      check(await may_move(c, booking));
      check(
        same(booking.account, c.actor) &&
          ["held", "confirmed"].includes(booking.status) &&
          booking.allowance === "not_required" &&
          !booking.intervals.length &&
          booking.checked_in === null &&
          compareInstant(from, c.now) >= 0 &&
          compareInstant(from, until) < 0 &&
          durationBetween(until, from) === durationBetween(booking.until, booking.from),
      );
      check(
        await free(
          c,
          booking.parent,
          subtractDuration(from, booking.parent.buffer_before),
          addDuration(until, booking.parent.buffer_after),
          booking.quantity,
          booking,
        ),
      );
      await set(c, booking, {
        from,
        until,
        reserved_from: subtractDuration(from, booking.parent.buffer_before),
        reserved_until: addDuration(until, booking.departure_buffer),
      });
      await create(c, "rent_reservations.ResourcePolicy", {
        parent: booking.parent,
        sequence: int64(
          (await count(
            records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
          )) + 1n,
        ),
        value: await resource_evidence(c, booking.parent),
      });
      await emit(c, "rent_reservations.ReservationChanged", {
        booking,
        revision: int64(booking.version + 1n),
      });
    },
    async move_days(c, { booking, start, end }) {
      check(hasRole(c, "authenticated"), "forbidden");
      check(await may_move(c, booking));
      check(
        same(booking.account, c.actor) &&
          ["held", "confirmed"].includes(booking.status) &&
          booking.allowance === "not_required" &&
          booking.quote === null &&
          booking.checked_in === null &&
          booking.intervals.length > 0 &&
          compareDate(start, end) < 0,
      );
      const access = [];
      const days = [];
      for await (const day of records(c, "rent_reservations.DayCalendar", {
        parent: booking.parent,
        where: (day) =>
          compareDate(start, day.day) <= 0 && compareDate(day.day, end) < 0 && !day.closed,
      }))
        days.push(day);
      days.sort((a, b) => compareDate(a.day, b.day));
      for (const day of days)
        access.push({
          from: subtractDuration(
            local_instant(day.day, day.opens, booking.parent.timezone, { fold: day.fold }),
            booking.parent.buffer_before,
          ),
          until: addDuration(
            local_instant(day.day, day.closes, booking.parent.timezone, { fold: day.fold }),
            booking.departure_buffer,
          ),
        });
      check(
        (await count(access)) === (await count(booking.intervals)) &&
          (await count(access)) === BigInt(dates(start, end, 1000n).length),
      );
      for (const interval of access)
        check(
          compareInstant(c.now, interval.from) <= 0 &&
            (await free(
              c,
              booking.parent,
              interval.from,
              interval.until,
              booking.quantity,
              booking,
            )),
        );
      const first_day = at(access, 0n),
        last_day = at(access, (await count(access)) - 1n);
      await set(c, booking, {
        intervals: access,
        from: addDuration(first_day.from, booking.parent.buffer_before),
        until: subtractDuration(last_day.until, booking.departure_buffer),
        reserved_from: first_day.from,
        reserved_until: last_day.until,
      });
      await create(c, "rent_reservations.ResourcePolicy", {
        parent: booking.parent,
        sequence: int64(
          (await count(
            records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
          )) + 1n,
        ),
        value: await resource_evidence(c, booking.parent),
      });
      await emit(c, "rent_reservations.ReservationChanged", {
        booking,
        revision: int64(booking.version + 1n),
      });
    },
    async overdue_occupancy(c, { event }) {
      const occupied = event.booking;
      check(
        occupied.checked_in !== null &&
          occupied.checked_out === null &&
          compareInstant(occupied.until, c.now) <= 0,
      );
      await set(c, occupied, { overdue: true });
      for await (const booking of records(c, "rent_reservations.Booking", {
        parent: occupied.parent,
        where: (row) => !same(row, occupied) && busy(c, row),
        limit: 1000n,
      }))
        if (!(await bookable(c, booking)))
          await create(c, "rent_reservations.Conflict", {
            parent: booking.parent,
            booking,
            reason: "Overdue occupant retains capacity",
          });
    },
    async move_membership(c, { booking, from, until }) {
      check(hasRole(c, "authenticated"), "forbidden");
      check(await may_move(c, booking));
      check(
        same(booking.account, c.actor) &&
          booking.status === "confirmed" &&
          booking.allowance === "consumed" &&
          booking.quote === null &&
          booking.checked_in === null &&
          compareInstant(c.now, booking.refund_before) < 0,
      );
      for await (const movement of records(c, "rent_reservations.Movement", { parent: booking }))
        check(
          !["holding", "waiting_money", "committing", "cancelling", "review"].includes(
            movement.state,
          ),
        );
      check(
        booking.benefit_unit === "hour" &&
          compareInstant(from, until) < 0 &&
          durationBetween(until, from) === durationBetween(booking.until, booking.from),
      );
      const access = [{ from, until }];
      for (const interval of access)
        check(
          compareInstant(c.now, interval.from) <= 0 &&
            (await free(
              c,
              booking.parent,
              subtractDuration(interval.from, booking.arrival_buffer),
              addDuration(interval.until, booking.departure_buffer),
              booking.quantity,
              booking,
            )),
        );
      const movement = await create(c, "rent_reservations.Movement", {
        parent: booking,
        source: c.operation.id,
        intervals: access,
        expires: addDuration(c.now, booking.parent.hold_for),
      });
      const allocation = await send(c, "rent_reservations.Membership.reserve", {
        value: movement_request(c, movement),
      });
      await set(c, movement, { reserve_delivery: allocation.id });
      await schedule(c, movement.id, movement.expires, "rent_reservations.MovementDue", {
        movement,
      });
    },
    async move_membership_days(c, { booking, start, end }) {
      check(hasRole(c, "authenticated"), "forbidden");
      check(await may_move(c, booking));
      check(
        same(booking.account, c.actor) &&
          booking.status === "confirmed" &&
          booking.allowance === "consumed" &&
          booking.quote === null &&
          booking.checked_in === null &&
          compareInstant(c.now, booking.refund_before) < 0,
      );
      for await (const movement of records(c, "rent_reservations.Movement", { parent: booking }))
        check(
          !["holding", "waiting_money", "committing", "cancelling", "review"].includes(
            movement.state,
          ),
        );
      check(booking.benefit_unit === "day" && compareDate(start, end) < 0);
      const days = [];
      for await (const day of records(c, "rent_reservations.DayCalendar", {
        parent: booking.parent,
        where: (day) =>
          compareDate(start, day.day) <= 0 && compareDate(day.day, end) < 0 && !day.closed,
      }))
        days.push(day);
      days.sort((a, b) => compareDate(a.day, b.day));
      const access = days.map((day) => ({
        from: local_instant(day.day, day.opens, booking.parent.timezone, { fold: day.fold }),
        until: local_instant(day.day, day.closes, booking.parent.timezone, { fold: day.fold }),
      }));
      check(
        access.length === booking.benefit_intervals.length &&
          access.length === dates(start, end, 1000n).length,
      );
      for (const interval of access)
        check(
          compareInstant(c.now, interval.from) <= 0 &&
            (await free(
              c,
              booking.parent,
              subtractDuration(interval.from, booking.arrival_buffer),
              addDuration(interval.until, booking.departure_buffer),
              booking.quantity,
              booking,
            )),
        );
      const movement = await create(c, "rent_reservations.Movement", {
        parent: booking,
        source: c.operation.id,
        intervals: access,
        expires: addDuration(c.now, booking.parent.hold_for),
      });
      const allocation = await send(c, "rent_reservations.Membership.reserve", {
        value: movement_request(c, movement),
      });
      await set(c, movement, { reserve_delivery: allocation.id });
      await schedule(c, movement.id, movement.expires, "rent_reservations.MovementDue", {
        movement,
      });
    },
    async movement_reserved(c, { event }) {
      for await (const movement of records(c, "rent_reservations.Movement", {
        where: (row) => row.reserve_delivery === event.delivery_id,
        limit: 1n,
      })) {
        if (
          event.status === "succeeded" &&
          event.result !== null &&
          event.result.source === movement.source
        )
          await emit(c, "rent_reservations.MovementObserved", { movement, value: event.result });
        if (event.status === "failed" && movement.state === "holding") {
          await set(c, movement, { state: "cancelling" });
          const release = await send(c, "rent_reservations.Membership.release", {
            source: movement.source,
            customer: movement.parent.customer.id,
          });
          await set(c, movement, { release_delivery: release.id });
          await send(c, "rent_reservations.Billing.cancel", {
            source: movement.source,
            reason: "Workspace move abandoned",
          });
        }
      }
    },
    async movement_committed(c, { event }) {
      for await (const movement of records(c, "rent_reservations.Movement", {
        where: (row) => row.commit_delivery === event.delivery_id,
        limit: 1n,
      })) {
        if (
          event.status === "succeeded" &&
          event.result !== null &&
          event.result.source === movement.source
        )
          await emit(c, "rent_reservations.MovementObserved", { movement, value: event.result });
        if (event.status === "failed" && movement.state === "committing") {
          await set(c, movement, { state: "cancelling" });
          const release = await send(c, "rent_reservations.Membership.release", {
            source: movement.source,
            customer: movement.parent.customer.id,
          });
          await set(c, movement, { release_delivery: release.id });
          await send(c, "rent_reservations.Billing.cancel", {
            source: movement.source,
            reason: "Workspace move abandoned",
          });
        }
      }
    },
    async movement_changed(c, { event }) {
      for await (const movement of records(c, "rent_reservations.Movement", {
        where: (row) => row.source === event.value.source,
        limit: 1n,
      }))
        await emit(c, "rent_reservations.MovementObserved", { movement, value: event.value });
    },
    async movement_result(c, { event }) {
      const movement = event.movement,
        booking = movement.parent;
      check(event.value.source === movement.source);
      if (
        event.value.phase === "staged" &&
        event.value.state === "confirmed" &&
        ["holding", "waiting_money"].includes(movement.state)
      ) {
        check(
          event.value.unit === booking.benefit_unit &&
            event.value.duration === booking.benefit_duration &&
            equalMoney(event.value.rate, booking.benefit_rate ?? booking.rate),
        );
        const discount = multiplyMoney(event.value.overage, booking.discount_fraction),
          tax = multiplyMoney(subtractMoney(event.value.overage, discount), booking.tax_fraction),
          balance = addMoney(subtractMoney(event.value.overage, discount), tax),
          old_balance = booking.service_due ?? booking.monetary_due ?? booking.total;
        let available = true;
        for (const interval of movement.intervals)
          if (
            !(await free(
              c,
              booking.parent,
              subtractDuration(interval.from, booking.arrival_buffer),
              addDuration(interval.until, booking.departure_buffer),
              0n,
              null,
            ))
          )
            available = false;
        if (
          compareInstant(c.now, booking.refund_before) < 0 &&
          compareInstant(c.now, movement.expires) < 0 &&
          booking.status === "confirmed" &&
          booking.checked_in === null &&
          available
        ) {
          if (compareMoney(balance, old_balance) <= 0 || movement.extra_paid) {
            await set(c, movement, {
              state: "committing",
              outcome: event.value,
              credit_due: max([
                money(0n, booking.total.currency),
                subtractMoney(old_balance, balance),
              ]),
            });
            const commit = await send(c, "rent_reservations.Membership.commit", {
              source: movement.source,
              customer: booking.customer.id,
            });
            await set(c, movement, { commit_delivery: commit.id });
          } else if (movement.extra_delivery === null) {
            const extra = subtractMoney(balance, old_balance),
              adjustment = await create(c, "rent_reservations.Adjustment", {
                parent: booking,
                source: movement.source,
                amount: extra,
                reason: "Membership movement overage",
                movement,
              });
            const charge = await send(c, "rent_reservations.Billing.charge", {
              value: {
                source: movement.source,
                customer: booking.customer.id,
                location: booking.parent.location.id,
                description: "Membership movement overage",
                amount: extra,
                due: local_date(at(movement.intervals, 0n).from, booking.parent.timezone),
                terms: booking.terms,
                items: [
                  {
                    title: "Workspace movement balance",
                    quantity: "1",
                    price: subtractMoney(
                      event.value.overage,
                      booking.allowance_base ?? booking.subtotal,
                    ),
                    discount: subtractMoney(
                      discount,
                      booking.allowance_discount ?? booking.discount,
                    ),
                    tax: subtractMoney(tax, booking.allowance_tax ?? booking.tax),
                    unit: "adjustment",
                    from: at(movement.intervals, 0n).from,
                    until: at(movement.intervals, (await count(movement.intervals)) - 1n).until,
                    location: booking.parent.location.name,
                    reference: movement.source,
                  },
                ],
              },
            });
            await set(c, adjustment, { delivery: charge.id });
            await set(c, movement, {
              state: "waiting_money",
              outcome: event.value,
              extra_due: extra,
              extra_delivery: charge.id,
            });
          }
        } else {
          await set(c, movement, { state: "cancelling", outcome: event.value });
          const release = await send(c, "rent_reservations.Membership.release", {
            source: movement.source,
            customer: booking.customer.id,
          });
          await set(c, movement, { release_delivery: release.id });
          await send(c, "rent_reservations.Billing.cancel", {
            source: movement.source,
            reason: "Workspace move abandoned",
          });
        }
      }
      if (
        event.value.phase === "consumed" &&
        event.value.state === "confirmed" &&
        movement.state === "committing"
      ) {
        let available = true;
        for (const interval of movement.intervals)
          if (
            !(await free(
              c,
              booking.parent,
              subtractDuration(interval.from, booking.arrival_buffer),
              addDuration(interval.until, booking.departure_buffer),
              0n,
              null,
            ))
          )
            available = false;
        if (booking.status === "confirmed" && booking.checked_in === null && available) {
          const first = at(movement.intervals, 0n),
            last = at(movement.intervals, (await count(movement.intervals)) - 1n);
          await set(c, booking, {
            from: first.from,
            until: last.until,
            reserved_from: subtractDuration(first.from, booking.arrival_buffer),
            reserved_until: addDuration(last.until, booking.departure_buffer),
            service_due: addMoney(
              subtractMoney(
                event.value.overage,
                multiplyMoney(event.value.overage, booking.discount_fraction),
              ),
              multiplyMoney(
                subtractMoney(
                  event.value.overage,
                  multiplyMoney(event.value.overage, booking.discount_fraction),
                ),
                booking.tax_fraction,
              ),
            ),
            allowance_base: event.value.overage,
            allowance_discount: multiplyMoney(event.value.overage, booking.discount_fraction),
            allowance_tax: multiplyMoney(
              subtractMoney(
                event.value.overage,
                multiplyMoney(event.value.overage, booking.discount_fraction),
              ),
              booking.tax_fraction,
            ),
            allowance_source: movement.source,
            allowance_revision: event.value.revision,
            allowance_units: event.value.units,
            included_units: event.value.covered_units,
          });
          if (booking.benefit_unit === "day") {
            await set(c, booking, {
              intervals: movement.intervals.map((interval) => ({
                from: subtractDuration(interval.from, booking.arrival_buffer),
                until: addDuration(interval.until, booking.departure_buffer),
              })),
            });
          } else {
            await set(c, booking, { intervals: [] });
          }
          await create(c, "rent_reservations.ResourcePolicy", {
            parent: booking.parent,
            sequence: int64(
              (await count(
                records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
              )) + 1n,
            ),
            value: await resource_evidence(c, booking.parent),
          });
          await set(c, movement, { state: "adopted", outcome: event.value });
          await cancel(c, movement.id);
          await emit(c, "rent_reservations.ReservationChanged", {
            booking,
            revision: int64(booking.version + 1n),
          });
        } else {
          await set(c, movement, { state: "review", outcome: event.value });
          await set(c, booking, { status: "review", refund_state: "review" });
          await create(c, "rent_reservations.ResourcePolicy", {
            parent: booking.parent,
            sequence: int64(
              (await count(
                records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
              )) + 1n,
            ),
            value: await resource_evidence(c, booking.parent),
          });
          await emit(c, "rent_reservations.CommercialCheck", { booking });
        }
      }
      if (
        event.value.phase === "released" &&
        ["holding", "waiting_money", "cancelling"].includes(movement.state)
      ) {
        await set(c, movement, { state: "cancelled", outcome: event.value });
        await emit(c, "rent_reservations.MovementCleared", { movement });
      }
    },
    async movement_money(c, { event }) {
      for await (const movement of records(c, "rent_reservations.Movement", {
        where: (row) => row.source === event.value.source,
        limit: 1n,
      })) {
        const value = event.value;
        check(movement.extra_due !== null && equalMoney(value.amount, movement.extra_due));
        if (value.revision > movement.extra_revision) {
          await set(c, movement, { extra_revision: value.revision });
          if (
            compareMoney(subtractMoney(value.collected, value.refunded), movement.extra_due) >= 0
          ) {
            await set(c, movement, { extra_paid: true });
            if (movement.state === "waiting_money" && movement.outcome !== null)
              await emit(c, "rent_reservations.MovementObserved", {
                movement,
                value: movement.outcome,
              });
            if (["cancelling", "cancelled", "review"].includes(movement.state))
              for await (const adjustment of records(c, "rent_reservations.Adjustment", {
                parent: movement.parent,
                where: (row) => row.source === movement.source,
                limit: 1n,
              }))
                await set(c, adjustment, { state: "review" });
          }
        }
      }
    },
    async refund_movement_credit(c, { movement, charge_source, amount, reason }) {
      check(hasRole(c, "rent_reservations.billing"), "forbidden");
      check(
        (await can_work(c, c.actor, movement.parent.parent.location)) &&
          movement.state === "adopted" &&
          movement.credit_due !== null &&
          amount.currency === movement.credit_due.currency &&
          amount.minor > 0n &&
          reason.trim() !== "",
      );
      const requested = await sum(
        records(c, "rent_reservations.MovementCredit", {
          parent: movement,
          where: (credit) => credit.state !== "failed",
        }),
        (credit) => credit.amount,
        movement.credit_due.currency,
      );
      check(compareMoney(amount, subtractMoney(movement.credit_due, requested)) <= 0);
      const booking = movement.parent;
      if (charge_source === booking.source) {
        check(
          booking.collected !== null &&
            booking.refunded !== null &&
            compareMoney(amount, subtractMoney(booking.collected, booking.refunded)) <= 0,
        );
        const refund = await send(c, "rent_reservations.Billing.refund", {
          source: charge_source,
          amount,
          reason,
        });
        await create(c, "rent_reservations.MovementCredit", {
          parent: movement,
          charge_source,
          amount,
          baseline: await credit_baseline(c, charge_source, booking.refunded),
          delivery: refund.id,
          reason,
        });
      } else {
        let adjustment = null;
        for await (const row of records(c, "rent_reservations.Adjustment", {
          parent: booking,
          where: (row) => row.source === charge_source && row.state === "paid",
          limit: 1n,
        }))
          adjustment = row;
        check(
          adjustment !== null &&
            adjustment.collected !== null &&
            adjustment.refunded !== null &&
            compareMoney(amount, subtractMoney(adjustment.collected, adjustment.refunded)) <= 0,
        );
        const refund = await send(c, "rent_reservations.Billing.refund", {
          source: charge_source,
          amount,
          reason,
        });
        await create(c, "rent_reservations.MovementCredit", {
          parent: movement,
          charge_source,
          amount,
          baseline: await credit_baseline(c, charge_source, adjustment.refunded),
          delivery: refund.id,
          reason,
        });
      }
    },
    async movement_credit_result(c, { event }) {
      for await (const credit of records(c, "rent_reservations.MovementCredit", {
        where: (row) => row.delivery === event.delivery_id,
        limit: 1n,
      })) {
        if (event.status === "failed") await set(c, credit, { state: "failed" });
        if (event.status === "unknown") await set(c, credit, { state: "unknown" });
        if (
          event.status === "succeeded" &&
          event.result !== null &&
          event.result.state === "unavailable"
        )
          await set(c, credit, { state: "review" });
      }
    },
    async movement_credit_money(c, { event }) {
      for await (const credit of records(c, "rent_reservations.MovementCredit", {
        where: (row) => row.charge_source === event.value.source && row.state !== "paid",
        limit: 1000n,
      }))
        if (compareMoney(event.value.refunded, addMoney(credit.baseline, credit.amount)) >= 0)
          await set(c, credit, { state: "paid" });
    },
    async abandon_movement(c, { movement }) {
      check(hasRole(c, "authenticated"), "forbidden");
      check(
        same(movement.parent.account, c.actor) &&
          ["holding", "waiting_money"].includes(movement.state),
      );
      await set(c, movement, { state: "cancelling" });
      const release = await send(c, "rent_reservations.Membership.release", {
        source: movement.source,
        customer: movement.parent.customer.id,
      });
      await set(c, movement, { release_delivery: release.id });
      await send(c, "rent_reservations.Billing.cancel", {
        source: movement.source,
        reason: "Workspace move abandoned",
      });
      await cancel(c, movement.id);
    },
    async movement_expire(c, { event }) {
      const movement = event.movement;
      check(
        ["holding", "waiting_money"].includes(movement.state) &&
          compareInstant(movement.expires, c.now) <= 0,
      );
      await set(c, movement, { state: "cancelling" });
      const release = await send(c, "rent_reservations.Membership.release", {
        source: movement.source,
        customer: movement.parent.customer.id,
      });
      await set(c, movement, { release_delivery: release.id });
      await send(c, "rent_reservations.Billing.cancel", {
        source: movement.source,
        reason: "Workspace move abandoned",
      });
    },
    async movement_released(c, { event }) {
      for await (const movement of records(c, "rent_reservations.Movement", {
        where: (row) => row.release_delivery === event.delivery_id,
        limit: 1n,
      }))
        if (
          event.status === "succeeded" &&
          event.result !== null &&
          event.result.source === movement.source &&
          event.result.state === "released" &&
          movement.state === "cancelling"
        ) {
          await set(c, movement, { state: "cancelled" });
          await emit(c, "rent_reservations.MovementCleared", { movement });
        }
    },
    async movement_cancellation(c, { event }) {
      const booking = event.movement.parent;
      let outstanding = false;
      for await (const movement of records(c, "rent_reservations.Movement", { parent: booking }))
        if (
          ["holding", "waiting_money", "committing", "cancelling", "review"].includes(
            movement.state,
          )
        )
          outstanding = true;
      if (
        booking.status === "cancelled" &&
        booking.allowance !== "not_required" &&
        booking.release_delivery === null &&
        !outstanding &&
        (["pending", "reserved"].includes(booking.allowance) || booking.cancellation_restore)
      ) {
        const release = await send(c, "rent_reservations.Membership.release", {
          source: booking.allowance_source ?? booking.source,
          customer: booking.customer.id,
          restore_consumed: booking.cancellation_restore,
        });
        await set(c, booking, { release_delivery: release.id });
      }
    },
    async retry_movement_cleanup(c, { movement }) {
      check(hasRole(c, "authenticated"), "forbidden");
      check(same(movement.parent.account, c.actor) && movement.state === "cancelling");
      const release = await send(c, "rent_reservations.Membership.release", {
        source: movement.source,
        customer: movement.parent.customer.id,
        restore_consumed: movement.release_restore,
      });
      await set(c, movement, { release_delivery: release.id });
    },
    async reconcile_movement(c, { movement }) {
      check(hasRole(c, "authenticated"), "forbidden");
      check(
        same(movement.parent.account, c.actor) &&
          ["holding", "waiting_money", "committing", "cancelling", "review"].includes(
            movement.state,
          ),
      );
      const reconciliation = await send(c, "rent_reservations.Membership.reconcile", {
        source: movement.source,
        customer: movement.parent.customer.id,
      });
      await set(c, movement, { reconcile_delivery: reconciliation.id });
    },
    async movement_reconciled(c, { event }) {
      for await (const movement of records(c, "rent_reservations.Movement", {
        where: (row) => row.reconcile_delivery === event.delivery_id,
        limit: 1n,
      }))
        if (
          event.status === "succeeded" &&
          event.result !== null &&
          event.result.source === movement.source
        )
          await emit(c, "rent_reservations.MovementObserved", { movement, value: event.result });
    },
    async block(c, { resource, from, until = null, reason }) {
      check(hasRole(c, "rent_reservations.reservation_manager"), "forbidden");
      check(
        (await can_work(c, c.actor, resource.location)) &&
          reason.trim() !== "" &&
          (until === null || compareInstant(from, until) < 0),
      );
      await create(c, "rent_reservations.Downtime", {
        parent: resource,
        source: c.operation.id,
        from,
        until,
        reason,
      });
      await create(c, "rent_reservations.ResourcePolicy", {
        parent: resource,
        sequence: int64(
          (await count(records(c, "rent_reservations.ResourcePolicy", { parent: resource }))) + 1n,
        ),
        value: await resource_evidence(c, resource),
      });
      for await (const booking of records(c, "rent_reservations.Booking", {
        parent: resource,
        where: (b) =>
          busy(c, b) &&
          compareInstant(b.reserved_from, until ?? b.reserved_until) < 0 &&
          compareInstant(from, b.reserved_until) < 0,
        limit: 1000n,
      })) {
        await create(c, "rent_reservations.Conflict", { parent: resource, booking, reason });
      }
    },
    async restore(c, { downtime, evidence }) {
      check(hasRole(c, "rent_reservations.reservation_manager"), "forbidden");
      check(
        (await can_work(c, c.actor, downtime.parent.location)) &&
          downtime.active &&
          evidence.trim() !== "",
      );
      await set(c, downtime, { active: false, verified_by: c.actor, verification: evidence });
      await create(c, "rent_reservations.ResourcePolicy", {
        parent: downtime.parent,
        sequence: int64(
          (await count(
            records(c, "rent_reservations.ResourcePolicy", { parent: downtime.parent }),
          )) + 1n,
        ),
        value: await resource_evidence(c, downtime.parent),
      });
    },
    async prepare(c, { booking, use_allowance = false }) {
      check(hasRole(c, "authenticated") || hasRole(c, "rent_reservations.reception"), "forbidden");
      check(
        (same(booking.account, c.actor) ||
          (hasRole(c, "rent_reservations.reception") &&
            (await can_work(c, c.actor, booking.parent.location)))) &&
          booking.status === "held" &&
          booking.billing_delivery === null &&
          compareInstant(c.now, booking.expires) < 0 &&
          booking.total.minor > 0n,
      );
      if (use_allowance || booking.allowance === "pending") {
        const allocation = await send(c, "rent_reservations.Membership.reserve", {
          value: benefit_request(c, booking),
        });
        await set(c, booking, {
          status: "pending",
          allowance: "pending",
          allowance_delivery: allocation.id,
        });
        await create(c, "rent_reservations.ResourcePolicy", {
          parent: booking.parent,
          sequence: int64(
            (await count(
              records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
            )) + 1n,
          ),
          value: await resource_evidence(c, booking.parent),
        });
      } else {
        const charge = await send(c, "rent_reservations.Billing.charge", {
          value: charge_request(c, booking, booking.subtotal, booking.discount, booking.tax),
        });
        await set(c, booking, {
          status: "pending",
          payment: "pending",
          billing_delivery: charge.id,
          monetary_due: booking.total,
        });
        await create(c, "rent_reservations.ResourcePolicy", {
          parent: booking.parent,
          sequence: int64(
            (await count(
              records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
            )) + 1n,
          ),
          value: await resource_evidence(c, booking.parent),
        });
      }
    },
    async arrive(c, { booking }) {
      check(hasRole(c, "rent_reservations.reception"), "forbidden");
      check(
        (await can_work(c, c.actor, booking.parent.location)) &&
          booking.status === "confirmed" &&
          ["paid", "free", "on_account"].includes(booking.payment) &&
          ["not_required", "consumed"].includes(booking.allowance),
      );
      check(
        (!booking.intervals.length &&
          compareInstant(booking.from, c.now) <= 0 &&
          compareInstant(c.now, booking.until) < 0) ||
          booking.intervals.some(
            (interval) =>
              compareInstant(addDuration(interval.from, booking.arrival_buffer), c.now) <= 0 &&
              compareInstant(c.now, subtractDuration(interval.until, booking.departure_buffer)) < 0,
          ),
      );
      check(
        (await bookable(c, booking)) &&
          (booking.payment !== "paid" || (await financial_cover(c, booking))) &&
          booking.customer.active &&
          (booking.payment !== "on_account" ||
            (await credit_allowed(c, booking.customer, booking.parent))),
      );
      await set(c, booking, { status: "occupied", checked_in: c.now });
      await create(c, "rent_reservations.ResourcePolicy", {
        parent: booking.parent,
        sequence: int64(
          (await count(
            records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
          )) + 1n,
        ),
        value: await resource_evidence(c, booking.parent),
      });
      await schedule(
        c,
        `${booking.source}:occupancy`,
        booking.until,
        "rent_reservations.OccupancyDue",
        { booking },
      );
      await emit(c, "rent_reservations.ReservationChanged", {
        booking,
        revision: int64(booking.version + 1n),
      });
    },
    async depart(c, { booking }) {
      check(hasRole(c, "rent_reservations.reception"), "forbidden");
      check(
        (await can_work(c, c.actor, booking.parent.location)) &&
          booking.checked_in !== null &&
          booking.checked_out === null,
      );
      const buffered = addDuration(c.now, booking.departure_buffer);
      await cancel(c, `${booking.source}:occupancy`);
      await set(c, booking, {
        status: "completed",
        overdue: false,
        checked_out: c.now,
        reserved_until:
          compareInstant(booking.reserved_until, buffered) < 0 ? buffered : booking.reserved_until,
      });
      await create(c, "rent_reservations.ResourcePolicy", {
        parent: booking.parent,
        sequence: int64(
          (await count(
            records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
          )) + 1n,
        ),
        value: await resource_evidence(c, booking.parent),
      });
      await emit(c, "rent_reservations.ReservationChanged", {
        booking,
        revision: int64(booking.version + 1n),
      });
    },
    async cancel_booking(c, { booking, reason }) {
      check(hasRole(c, "authenticated") || hasRole(c, "rent_reservations.reception"), "forbidden");
      check(
        (same(booking.account, c.actor) ||
          (hasRole(c, "rent_reservations.reception") &&
            (await can_work(c, c.actor, booking.parent.location)))) &&
          !["cancelled", "completed"].includes(booking.status) &&
          reason.trim() !== "",
      );
      const restore =
        ["held", "pending"].includes(booking.status) ||
        compareInstant(c.now, booking.refund_before) < 0;
      await set(c, booking, {
        status: "cancelled",
        cancellation_reason: reason,
        cancellation_restore: restore,
      });
      await create(c, "rent_reservations.ResourcePolicy", {
        parent: booking.parent,
        sequence: int64(
          (await count(
            records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
          )) + 1n,
        ),
        value: await resource_evidence(c, booking.parent),
      });
      await cancel(c, booking.id);
      let cleanupPending = false;
      for await (const movement of records(c, "rent_reservations.Movement", { parent: booking })) {
        if (["holding", "waiting_money", "committing"].includes(movement.state)) {
          await set(c, movement, { state: "cancelling", release_restore: restore });
          const release = await send(c, "rent_reservations.Membership.release", {
            source: movement.source,
            customer: booking.customer.id,
            restore_consumed: restore,
          });
          await set(c, movement, { release_delivery: release.id });
          await send(c, "rent_reservations.Billing.cancel", { source: movement.source, reason });
          await cancel(c, movement.id);
        }
        if (["cancelling", "review"].includes(movement.state)) cleanupPending = true;
      }
      if (
        booking.allowance !== "not_required" &&
        booking.release_delivery === null &&
        !cleanupPending &&
        (["pending", "reserved"].includes(booking.allowance) || restore)
      ) {
        const release = await send(c, "rent_reservations.Membership.release", {
          source: booking.allowance_source ?? booking.source,
          customer: booking.customer.id,
          restore_consumed: restore,
        });
        await set(c, booking, { release_delivery: release.id });
      }
      const invoice_cancel = await send(c, "rent_reservations.Billing.cancel", {
        source: booking.source,
        reason,
      });
      await set(c, booking, { cancel_delivery: invoice_cancel.id });
      if (
        booking.payment === "paid" &&
        compareInstant(c.now, booking.refund_before) < 0 &&
        booking.refund_amount.minor > 0n
      ) {
        const refund = await send(c, "rent_reservations.Billing.refund", {
          source: booking.source,
          amount: max([
            money(0n, booking.total.currency),
            subtractMoney(
              booking.monetary_due ?? booking.total,
              subtractMoney(booking.total, booking.refund_amount),
            ),
          ]),
          reason,
        });
        await set(c, booking, {
          refund_delivery: refund.id,
          refund_state: "pending",
          refund_requested: max([
            money(0n, booking.total.currency),
            subtractMoney(
              booking.monetary_due ?? booking.total,
              subtractMoney(booking.total, booking.refund_amount),
            ),
          ]),
        });
      }
      await emit(c, "rent_reservations.ReservationChanged", {
        booking,
        revision: int64(booking.version + 1n),
      });
    },
    async venue_move(c, { event }) {
      const value = event.value;
      check(
        value.price === null &&
          value.terms === null &&
          compareInstant(value.from, c.now) >= 0 &&
          compareInstant(value.from, value.until) < 0,
      );
      for await (const venue of records(c, "rent_reservations.VenueReservation", {
        where: (v) => v.source === value.source && v.parent.id === value.resource,
        limit: 1n,
      })) {
        check(
          ["held", "confirmed"].includes(venue.status) &&
            same(venue.account, value.account) &&
            venue.customer === value.customer &&
            venue.quantity === value.quantity &&
            venue.version === value.revision,
        );
        check(
          await free(
            c,
            venue.parent,
            subtractDuration(value.from, venue.parent.buffer_before),
            addDuration(value.until, venue.parent.buffer_after),
            venue.quantity,
            null,
            venue,
          ),
        );
        await set(c, venue, {
          from: subtractDuration(value.from, venue.parent.buffer_before),
          until: addDuration(value.until, venue.parent.buffer_after),
        });
        await create(c, "rent_reservations.ResourcePolicy", {
          parent: venue.parent,
          sequence: int64(
            (await count(
              records(c, "rent_reservations.ResourcePolicy", { parent: venue.parent }),
            )) + 1n,
          ),
          value: await resource_evidence(c, venue.parent),
        });
        await emit(c, "rent_reservations.VenueOutcome", {
          value: {
            source: venue.source,
            revision: int64(venue.version + 1n),
            state: "confirmed",
            reference: venue.id,
            detail: "Venue interval moved",
          },
        });
      }
    },
    async requested_affected(c, { event }) {
      for await (const downtime of records(c, "rent_reservations.Downtime", {
        where: (row) => row.source === event.source && row.parent.id === event.resource,
        limit: 1n,
      })) {
        const items = [];
        for await (const booking of records(c, "rent_reservations.Booking", {
          parent: downtime.parent,
        }))
          if (
            busy(c, booking) &&
            overlaps(
              booking.reserved_from,
              booking.reserved_until,
              downtime.from,
              downtime.until ?? booking.reserved_until,
            )
          )
            items.push({
              reference: booking.id,
              revision: booking.version,
              from: booking.from,
              until: booking.until,
              quantity: booking.quantity,
              status: booking.status,
              conflict: null,
            });
        await emit(c, "rent_reservations.AffectedOutcome", {
          value: {
            source: event.source,
            resource: event.resource,
            revision: downtime.version,
            checked_at: c.now,
            items,
          },
        });
      }
    },
    async requested_downtime(c, { event }) {
      check(event.until === null || compareInstant(event.from, event.until) < 0);
      for await (const resource of records(c, "rent_reservations.Resource", {
        where: (row) => row.id === event.resource,
        limit: 1n,
      })) {
        let fenced = false;
        for await (const fence of records(c, "rent_reservations.DowntimeFence", {
          parent: resource,
        }))
          if (fence.source === event.source) fenced = true;
        if (fenced)
          await emit(c, "rent_reservations.VenueOutcome", {
            value: {
              source: event.source,
              revision: 1n,
              state: "released",
              detail: "Previously restored downtime",
            },
          });
        else {
          let existing = null;
          for await (const downtime of records(c, "rent_reservations.Downtime", {
            parent: resource,
            where: (row) => row.source === event.source,
            limit: 1n,
          }))
            existing = downtime;
          if (existing !== null) {
            check(
              equalValue(c, "datetime", existing.from, event.from) &&
                equalValue(c, "datetime?", existing.until, event.until),
            );
            await emit(c, "rent_reservations.VenueOutcome", {
              value: {
                source: event.source,
                revision: existing.version,
                state: existing.active ? "confirmed" : "released",
                reference: existing.id,
              },
            });
          } else {
            const downtime = await create(c, "rent_reservations.Downtime", {
              parent: resource,
              source: event.source,
              from: event.from,
              until: event.until,
              reason: "Requested maintenance",
            });
            await create(c, "rent_reservations.ResourcePolicy", {
              parent: downtime.parent,
              sequence: int64(
                (await count(
                  records(c, "rent_reservations.ResourcePolicy", { parent: downtime.parent }),
                )) + 1n,
              ),
              value: await resource_evidence(c, downtime.parent),
            });
            for await (const booking of records(c, "rent_reservations.Booking", {
              parent: resource,
              where: (b) =>
                busy(c, b) &&
                compareInstant(b.reserved_from, event.until ?? b.reserved_until) < 0 &&
                compareInstant(event.from, b.reserved_until) < 0,
              limit: 1000n,
            }))
              await create(c, "rent_reservations.Conflict", {
                parent: resource,
                booking,
                downtime,
                reason: "Requested maintenance",
              });
            await emit(c, "rent_reservations.VenueOutcome", {
              value: {
                source: event.source,
                revision: downtime.version,
                state: "confirmed",
                reference: downtime.id,
              },
            });
          }
        }
      }
    },
    async requested_restore(c, { event }) {
      check(event.evidence.trim() !== "");
      for await (const resource of records(c, "rent_reservations.Resource", {
        where: (row) => row.id === event.resource,
        limit: 1n,
      })) {
        let fence = null;
        for await (const row of records(c, "rent_reservations.DowntimeFence", {
          parent: resource,
          where: (row) => row.source === event.source,
          limit: 1n,
        }))
          fence = row;
        check(fence === null || fence.evidence === event.evidence);
        if (fence === null)
          await create(c, "rent_reservations.DowntimeFence", {
            parent: resource,
            source: event.source,
            evidence: event.evidence,
          });
        let found = false;
        for await (const downtime of records(c, "rent_reservations.Downtime", {
          parent: resource,
          where: (row) => row.source === event.source,
          limit: 1n,
        })) {
          found = true;
          if (downtime.active) {
            await set(c, downtime, { active: false, verification: event.evidence });
            await create(c, "rent_reservations.ResourcePolicy", {
              parent: downtime.parent,
              sequence: int64(
                (await count(
                  records(c, "rent_reservations.ResourcePolicy", { parent: downtime.parent }),
                )) + 1n,
              ),
              value: await resource_evidence(c, downtime.parent),
            });
            await emit(c, "rent_reservations.VenueOutcome", {
              value: {
                source: event.source,
                revision: int64(downtime.version + 1n),
                state: "released",
                reference: downtime.id,
                detail: event.evidence,
              },
            });
          } else
            await emit(c, "rent_reservations.VenueOutcome", {
              value: {
                source: event.source,
                revision: downtime.version,
                state: "released",
                reference: downtime.id,
                detail: downtime.verification,
              },
            });
        }
        if (!found)
          await emit(c, "rent_reservations.VenueOutcome", {
            value: {
              source: event.source,
              revision: 1n,
              state: "released",
              detail: event.evidence,
            },
          });
      }
    },
    async venue_hold(c, { event }) {
      const value = event.value;
      check(
        value.price === null &&
          value.terms === null &&
          compareInstant(value.from, c.now) >= 0 &&
          compareInstant(value.from, value.until) < 0 &&
          value.quantity > 0n,
      );
      for await (const resource of records(c, "rent_reservations.Resource", {
        where: (r) => r.id === value.resource,
        limit: 1n,
      })) {
        for await (const fence of records(c, "rent_reservations.VenueFence", { parent: resource }))
          check(fence.source !== value.source);
        for await (const venue of records(c, "rent_reservations.VenueReservation", {
          parent: resource,
        }))
          check(venue.source !== value.source);
        check(
          await free(
            c,
            resource,
            subtractDuration(value.from, resource.buffer_before),
            addDuration(value.until, resource.buffer_after),
            value.quantity,
            null,
          ),
        );
        const venue = await create(c, "rent_reservations.VenueReservation", {
          parent: resource,
          source: value.source,
          request_revision: value.revision,
          customer: value.customer,
          account: value.account,
          from: subtractDuration(value.from, resource.buffer_before),
          until: addDuration(value.until, resource.buffer_after),
          quantity: value.quantity,
          expires: addDuration(c.now, resource.hold_for),
        });
        await create(c, "rent_reservations.ResourcePolicy", {
          parent: venue.parent,
          sequence: int64(
            (await count(
              records(c, "rent_reservations.ResourcePolicy", { parent: venue.parent }),
            )) + 1n,
          ),
          value: await resource_evidence(c, venue.parent),
        });
        await schedule(c, venue.id, venue.expires, "rent_reservations.VenueDue", { venue });
        await emit(c, "rent_reservations.VenueOutcome", {
          value: {
            source: venue.source,
            revision: venue.version,
            state: "pending",
            reference: venue.id,
            detail: "Provisional appointment venue",
          },
        });
      }
    },
    async venue_stage(c, { event }) {
      const { value, previous_source, previous_revision } = event;
      check(
        value.price === null &&
          value.terms === null &&
          compareInstant(value.from, c.now) >= 0 &&
          compareInstant(value.from, value.until) < 0,
      );
      for await (const previous of records(c, "rent_reservations.VenueReservation", {
        where: (v) => v.source === previous_source && v.parent.id === value.resource,
        limit: 1n,
      })) {
        check(
          previous.version === previous_revision &&
            previous.status === "confirmed" &&
            previous.parent.id === value.resource &&
            same(previous.account, value.account) &&
            previous.customer === value.customer &&
            previous.quantity === value.quantity,
        );
        for await (const fence of records(c, "rent_reservations.VenueFence", {
          parent: previous.parent,
        }))
          check(fence.source !== value.source);
        for await (const venue of records(c, "rent_reservations.VenueReservation", {
          parent: previous.parent,
        }))
          check(
            !(
              venue.source === value.source ||
              (same(venue.previous, previous) && venue_busy(c, venue))
            ),
          );
        check(
          await free(
            c,
            previous.parent,
            subtractDuration(value.from, previous.parent.buffer_before),
            addDuration(value.until, previous.parent.buffer_after),
            value.quantity,
            null,
            previous,
          ),
        );
        const venue = await create(c, "rent_reservations.VenueReservation", {
          parent: previous.parent,
          source: value.source,
          request_revision: value.revision,
          customer: value.customer,
          account: value.account,
          from: subtractDuration(value.from, previous.parent.buffer_before),
          until: addDuration(value.until, previous.parent.buffer_after),
          quantity: value.quantity,
          expires: addDuration(c.now, previous.parent.hold_for),
          status: "staged",
          previous,
        });
        await create(c, "rent_reservations.ResourcePolicy", {
          parent: venue.parent,
          sequence: int64(
            (await count(
              records(c, "rent_reservations.ResourcePolicy", { parent: venue.parent }),
            )) + 1n,
          ),
          value: await resource_evidence(c, venue.parent),
        });
        await schedule(c, venue.id, venue.expires, "rent_reservations.VenueDue", { venue });
        await emit(c, "rent_reservations.VenueOutcome", {
          value: {
            source: venue.source,
            revision: venue.version,
            state: "pending",
            reference: venue.id,
            detail: "Candidate held; predecessor retained",
          },
        });
      }
    },
    async venue_confirm(c, { event }) {
      for await (const venue of records(c, "rent_reservations.VenueReservation", {
        where: (v) => v.source === event.source && v.parent.id === event.resource,
        limit: 1n,
      })) {
        check(
          ["held", "staged"].includes(venue.status) && compareInstant(c.now, venue.expires) < 0,
        );
        check(await free(c, venue.parent, venue.from, venue.until, 0n, null));
        await set(c, venue, { status: "confirmed" });
        await create(c, "rent_reservations.ResourcePolicy", {
          parent: venue.parent,
          sequence: int64(
            (await count(
              records(c, "rent_reservations.ResourcePolicy", { parent: venue.parent }),
            )) + 1n,
          ),
          value: await resource_evidence(c, venue.parent),
        });
        await cancel(c, venue.id);
        await emit(c, "rent_reservations.VenueOutcome", {
          value: {
            source: venue.source,
            revision: int64(venue.version + 1n),
            state: "confirmed",
            reference: venue.id,
            detail: "Appointment venue confirmed",
          },
        });
      }
    },
    async venue_release(c, { event }) {
      for await (const resource of records(c, "rent_reservations.Resource", {
        where: (r) => r.id === event.resource,
        limit: 1n,
      })) {
        let fenced = false;
        for await (const fence of records(c, "rent_reservations.VenueFence", { parent: resource }))
          if (fence.source === event.source) fenced = true;
        if (!fenced)
          await create(c, "rent_reservations.VenueFence", {
            parent: resource,
            source: event.source,
            reason: event.reason,
          });
        let found = false;
        for await (const venue of records(c, "rent_reservations.VenueReservation", {
          parent: resource,
          where: (v) => v.source === event.source,
          limit: 1n,
        }))
          found = true;
        if (!found)
          await emit(c, "rent_reservations.VenueOutcome", {
            value: { source: event.source, revision: 1n, state: "released", detail: event.reason },
          });
        for await (const venue of records(c, "rent_reservations.VenueReservation", {
          parent: resource,
          where: (v) => v.source === event.source,
          limit: 1n,
        }))
          if (["held", "staged", "confirmed"].includes(venue.status)) {
            await set(c, venue, { status: "released", reason: event.reason });
            await create(c, "rent_reservations.ResourcePolicy", {
              parent: venue.parent,
              sequence: int64(
                (await count(
                  records(c, "rent_reservations.ResourcePolicy", { parent: venue.parent }),
                )) + 1n,
              ),
              value: await resource_evidence(c, venue.parent),
            });
            await cancel(c, venue.id);
            await emit(c, "rent_reservations.VenueOutcome", {
              value: {
                source: venue.source,
                revision: int64(venue.version + 1n),
                state: "released",
                reference: venue.id,
                detail: event.reason,
              },
            });
          } else
            await emit(c, "rent_reservations.VenueOutcome", {
              value: {
                source: venue.source,
                revision: venue.version,
                state: "released",
                reference: venue.id,
                detail: event.reason,
              },
            });
      }
    },
    async venue_expire(c, { event }) {
      const venue = event.venue;
      check(["held", "staged"].includes(venue.status) && compareInstant(venue.expires, c.now) <= 0);
      await set(c, venue, { status: "expired" });
      await create(c, "rent_reservations.ResourcePolicy", {
        parent: venue.parent,
        sequence: int64(
          (await count(records(c, "rent_reservations.ResourcePolicy", { parent: venue.parent }))) +
            1n,
        ),
        value: await resource_evidence(c, venue.parent),
      });
      await emit(c, "rent_reservations.VenueOutcome", {
        value: {
          source: venue.source,
          revision: int64(venue.version + 1n),
          state: "unavailable",
          reference: venue.id,
          detail: "Venue hold expired",
        },
      });
    },
    async quote_hold(c, { event }) {
      const value = event.value;
      check(
        compareInstant(c.now, value.hold_until) < 0 &&
          compareInstant(value.hold_until, value.snapshot.expires) <= 0 &&
          value.snapshot.resource === value.resource &&
          value.snapshot.quantity === value.quantity &&
          value.snapshot.attendees === value.attendees &&
          value.snapshot.recipient === value.recipient &&
          value.quantity > 0n &&
          value.attendees > 0n,
      );
      for await (const resource of records(c, "rent_reservations.Resource", {
        where: (r) => r.id === value.resource,
        limit: 1n,
      })) {
        check(
          resource.location.id === value.location &&
            value.attendees <= resource.party_limit &&
            (!resource.pooled || value.attendees <= value.quantity),
        );
        check(
          value.snapshot.total.currency === resource.currency &&
            value.snapshot.total.minor >= 0n &&
            compareInstant(value.snapshot.from, c.now) >= 0 &&
            compareInstant(value.snapshot.from, value.snapshot.until) < 0,
        );
        check(
          await all(
            value.snapshot.lines,
            (item) =>
              compareDecimal(item.quantity, "0") >= 0 &&
              (compareDecimal(item.quantity, "0") > 0 ||
                equalMoney(
                  subtractMoney(
                    addMoney(multiplyMoney(item.price, item.quantity), item.tax),
                    item.discount,
                  ),
                  money(0n, item.price.currency),
                )) &&
              item.price.currency === resource.currency &&
              item.tax.currency === resource.currency &&
              item.discount.currency === resource.currency &&
              item.price.minor >= 0n &&
              item.tax.minor >= 0n &&
              item.discount.minor >= 0n &&
              compareMoney(
                item.discount,
                addMoney(multiplyMoney(item.price, item.quantity), item.tax),
              ) <= 0,
          ),
        );
        check(
          equalMoney(
            value.snapshot.total,
            await sum(
              value.snapshot.lines,
              (item) =>
                subtractMoney(
                  addMoney(multiplyMoney(item.price, item.quantity), item.tax),
                  item.discount,
                ),
              resource.currency,
            ),
          ),
        );
        for await (const fence of records(c, "rent_reservations.ReservationFence", {
          parent: resource,
        }))
          check(!(fence.source === value.source && fence.revision === value.revision));
        for await (const hold of records(c, "rent_reservations.QuoteHold", { parent: resource }))
          check(hold.source !== value.source);
        check(await quote_available(c, resource, value.snapshot, value.quantity));
        const hold = await create(c, "rent_reservations.QuoteHold", {
          parent: resource,
          source: value.source,
          revision: value.revision,
          offer: value,
          quantity: value.quantity,
          from: subtractDuration(value.snapshot.from, resource.buffer_before),
          until: addDuration(value.snapshot.until, resource.buffer_after),
          intervals: value.snapshot.intervals.map((interval) => ({
            from: subtractDuration(interval.from, resource.buffer_before),
            until: addDuration(interval.until, resource.buffer_after),
          })),
          expires: value.hold_until,
        });
        await schedule(c, hold.id, hold.expires, "rent_reservations.QuoteDue", { hold });
        await emit(c, "rent_reservations.OfferOutcome", {
          value: {
            source: hold.source,
            revision: hold.revision,
            kind: "hold",
            version: hold.version,
            state: "confirmed",
            reference: hold.id,
            expires: hold.expires,
          },
        });
      }
    },
    async quote_accept(c, { event }) {
      const value = event.value;
      check(
        compareInstant(value.accepted_at, c.now) <= 0 &&
          compareInstant(value.accepted_at, value.snapshot.expires) <= 0 &&
          value.snapshot.resource === value.resource &&
          value.snapshot.quantity === value.quantity &&
          value.snapshot.attendees === value.attendees &&
          value.snapshot.recipient === value.recipient &&
          value.quantity > 0n &&
          value.attendees > 0n,
      );
      check(
        (value.attribution === null &&
          value.exclusive_program === null &&
          value.attributed_at === null &&
          value.attribution_window === null) ||
          (value.attribution !== null &&
            value.exclusive_program !== null &&
            value.attributed_at !== null &&
            value.attribution_window !== null &&
            value.attribution_window > 0n &&
            compareInstant(value.attributed_at, value.accepted_at) <= 0 &&
            compareInstant(
              value.accepted_at,
              addDuration(value.attributed_at, value.attribution_window),
            ) <= 0),
      );
      for await (const resource of records(c, "rent_reservations.Resource", {
        where: (r) => r.id === value.resource,
        limit: 1n,
      })) {
        for await (const booking of records(c, "rent_reservations.Booking", { parent: resource }))
          check(booking.source !== value.source);
        const fence = await first(records(c, "rent_reservations.ReservationFence", {
          parent: resource, where: row => row.source === value.source && row.revision === value.revision,
          order: ["id"],
        }));
        if (fence !== null) {
          check(fence.offer === null || equalValue(c, "propose.AcceptedOffer", fence.offer, value));
          await emit(c, "rent_reservations.OfferOutcome", {value: {
            source: fence.source, revision: fence.revision, kind: "booking",
            version: fence.version, state: "unavailable", detail: fence.reason,
          }});
        } else {
          check(
            value.attribution === null ||
              (value.product !== null &&
                value.product ===
                  format(
                    c,
                    message(
                      "{kind}",
                      {},
                      { kind: { type: "rent_reservations.Resource.kind", value: resource.kind } },
                    ),
                    { locale: null },
                  )),
          );
          check(
            resource.location.id === value.location &&
              value.attendees <= resource.party_limit &&
              (!resource.pooled || value.attendees <= value.quantity),
          );
          check(
            value.snapshot.total.currency === resource.currency &&
              value.snapshot.total.minor >= 0n &&
              compareInstant(value.snapshot.from, c.now) >= 0 &&
              compareInstant(value.snapshot.from, value.snapshot.until) < 0,
          );
          check(
            await all(
              value.snapshot.lines,
              (item) =>
                compareDecimal(item.quantity, "0") >= 0 &&
                (compareDecimal(item.quantity, "0") > 0 ||
                  equalMoney(
                    subtractMoney(
                      addMoney(multiplyMoney(item.price, item.quantity), item.tax),
                      item.discount,
                    ),
                    money(0n, item.price.currency),
                  )) &&
                item.price.currency === resource.currency &&
                item.tax.currency === resource.currency &&
                item.discount.currency === resource.currency &&
                item.price.minor >= 0n &&
                item.tax.minor >= 0n &&
                item.discount.minor >= 0n &&
                compareMoney(
                  item.discount,
                  addMoney(multiplyMoney(item.price, item.quantity), item.tax),
                ) <= 0,
            ),
          );
          check(
            equalMoney(
              value.snapshot.total,
              await sum(
                value.snapshot.lines,
                (item) =>
                  subtractMoney(
                    addMoney(multiplyMoney(item.price, item.quantity), item.tax),
                    item.discount,
                  ),
                resource.currency,
              ),
            ),
          );
          for await (const customer of records(c, "customer.Customer", {
            where: (r) => r.id === value.customer,
            limit: 1n,
          })) {
            check(await may_reserve(c, value.account, customer, resource));
            for await (const hold of records(c, "rent_reservations.QuoteHold", {
              parent: resource,
              where: (h) => h.source === value.source,
              limit: 1n,
            })) {
              check(
                hold.revision === value.revision &&
                  equalValue(c, "propose.QuoteDocument", hold.offer.snapshot, value.snapshot) &&
                  hold.offer.customer === value.customer && hold.offer.location === value.location &&
                  hold.quantity === value.quantity,
              );
              await set(c, hold, { active: false });
              await cancel(c, hold.id);
            }
            if (!await quote_available(c, resource, value.snapshot, value.quantity)) {
              const rejected = await create(c, "rent_reservations.ReservationFence", {
                parent: resource, source: value.source, revision: value.revision,
                reason: format(c, message("Quoted inventory unavailable", {nl:"Geoffreerde voorraad niet beschikbaar"}), {locale:null}), offer: value,
              });
              await emit(c, "rent_reservations.OfferOutcome", {value: {
                source: rejected.source, revision: rejected.revision, kind: "booking",
                version: rejected.version, state: "unavailable", detail: rejected.reason,
              }});
            } else {
              const booking = await create(c, "rent_reservations.Booking", {
                parent: resource,
                billing_location: resource.location,
                sale_product: format(
                  c,
                  message(
                    "{kind}",
                    {},
                    { kind: { type: "rent_reservations.Resource.kind", value: resource.kind } },
                  ),
                  { locale: null },
                ),
                purchased_at: value.accepted_at,
                attribution: value.attribution,
                exclusive_program: value.exclusive_program,
                attributed_at: value.attributed_at,
                attribution_window: value.attribution_window,
                customer,
                account: value.account,
                email: value.recipient,
                from: value.snapshot.from,
                until: value.snapshot.until,
                intervals: value.snapshot.intervals.map((interval) => ({
                  from: subtractDuration(interval.from, resource.buffer_before),
                  until: addDuration(interval.until, resource.buffer_after),
                })),
                original_intervals: value.snapshot.intervals.map((interval) => ({
                  from: subtractDuration(interval.from, resource.buffer_before),
                  until: addDuration(interval.until, resource.buffer_after),
                })),
                quantity: value.quantity,
                attendees: value.attendees,
                rate: value.snapshot.total,
                subtotal: await sum(
                  value.snapshot.lines,
                  (item) => multiplyMoney(item.price, item.quantity),
                  resource.currency,
                ),
                tax: await sum(value.snapshot.lines, (item) => item.tax, resource.currency),
                discount: await sum(
                  value.snapshot.lines,
                  (item) => item.discount,
                  resource.currency,
                ),
                total: value.snapshot.total,
                refund_amount: value.snapshot.total,
                terms: value.snapshot.terms,
                refund_before: value.snapshot.refund_before,
                reserved_from: subtractDuration(value.snapshot.from, resource.buffer_before),
                reserved_until: addDuration(value.snapshot.until, resource.buffer_after),
                expires: addDuration(c.now, resource.hold_for),
                source: value.source,
                quote: value,
                departure_buffer: resource.buffer_after,
                arrival_buffer: resource.buffer_before,
                benefit_unit: resource.price_unit,
                benefit_duration: resource.increment,
                benefit_rate: multiplyMoney(
                  resource.hourly,
                  divideDecimal(resource.increment, 3600000n),
                ),
                benefit_intervals: [{ from: value.snapshot.from, until: value.snapshot.until }],
              });
              if (booking.total.minor > 0n) {
                const charge = await send(c, "rent_reservations.Billing.charge", {
                  value: {
                    source: booking.source,
                    customer: booking.customer.id,
                    location: resource.location.id,
                    description: value.snapshot.title,
                    amount: booking.total,
                    due: local_date(booking.from, resource.timezone),
                    issuer: value.snapshot.issuer,
                    terms: value.snapshot.terms,
                    items: value.snapshot.lines.map((item) => ({
                      title: item.title,
                      quantity: item.quantity,
                      price: item.price,
                      tax: item.tax,
                      discount: item.discount,
                      unit: item.unit,
                      from: value.snapshot.from,
                      until: value.snapshot.until,
                      location: value.snapshot.location,
                      reference: value.source,
                    })),
                  },
                });
                await set(c, booking, {
                  status: "pending",
                  payment: "pending",
                  billing_delivery: charge.id,
                  monetary_due: booking.total,
                });
              }
              await create(c, "rent_reservations.ResourcePolicy", {
                parent: booking.parent,
                sequence: int64(
                  (await count(
                    records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
                  )) + 1n,
                ),
                value: await resource_evidence(c, booking.parent),
              });
              await schedule(c, booking.id, booking.expires, "rent_reservations.HoldDue", { booking });
              await emit(c, "rent_reservations.OfferOutcome", {
                value: {
                  source: booking.source,
                  revision: value.revision,
                  kind: "booking",
                  version: booking.version,
                  state: "pending",
                  reference: booking.id,
                  expires: booking.expires,
                },
              });
            }
          }
        }
      }
    },
    async quote_release(c, { event }) {
      const { source, revision, resource: resourceId, reason } = event;
      for await (const resource of records(c, "rent_reservations.Resource", {
        where: (r) => r.id === resourceId,
        limit: 1n,
      })) {
        let fenced = false;
        for await (const fence of records(c, "rent_reservations.ReservationFence", {
          parent: resource,
        }))
          if (fence.source === source && fence.revision === revision) fenced = true;
        if (!fenced)
          await create(c, "rent_reservations.ReservationFence", {
            parent: resource,
            source,
            revision,
            reason,
          });
        for await (const hold of records(c, "rent_reservations.QuoteHold", {
          parent: resource,
          where: (h) => h.source === source,
          limit: 1n,
        })) {
          check(hold.revision === revision);
          await set(c, hold, { active: false });
          await cancel(c, hold.id);
        }
        await emit(c, "rent_reservations.OfferOutcome", {
          value: { source, revision, kind: "release", version: 1n, state: "released" },
        });
      }
    },
    async quote_changed(c, { event }) {
      const { booking, revision } = event;
      check(booking.quote !== null && booking.version === revision);
      if (["confirmed", "occupied", "completed"].includes(booking.status))
        await emit(c, "rent_reservations.OfferOutcome", {
          value: {
            source: booking.source,
            revision: booking.quote.revision,
            kind: "booking",
            version: booking.version,
            state: "confirmed",
            reference: booking.id,
            invoice: booking.invoice,
            expires: booking.expires,
          },
        });
      else if (["cancelled", "expired", "review", "no_show"].includes(booking.status))
        await emit(c, "rent_reservations.OfferOutcome", {
          value: {
            source: booking.source,
            revision: booking.quote.revision,
            kind: "booking",
            version: booking.version,
            state: "unavailable",
            reference: booking.id,
            invoice: booking.invoice,
            expires: booking.expires,
          },
        });
      if (["held", "pending"].includes(booking.status))
        await emit(c, "rent_reservations.OfferOutcome", {
          value: {
            source: booking.source,
            revision: booking.quote.revision,
            kind: "booking",
            version: booking.version,
            state: booking.payment === "unknown" ? "unknown" : "pending",
            reference: booking.id,
            invoice: booking.invoice,
            expires: booking.expires,
          },
        });
    },
    async quote_expire(c, { event }) {
      const hold = event.hold;
      check(hold.active && compareInstant(hold.expires, c.now) <= 0);
      await set(c, hold, { active: false });
      await emit(c, "rent_reservations.OfferOutcome", {
        value: {
          source: hold.source,
          revision: hold.revision,
          kind: "hold",
          version: int64(hold.version + 1n),
          state: "unavailable",
          reference: hold.id,
          detail: "Quote capacity hold expired",
        },
      });
    },
    async revise_capacity(c, { resource, capacity, reason }) {
      check(hasRole(c, "rent_reservations.reservation_manager"), "forbidden");
      check(
        (await can_work(c, c.actor, resource.location)) &&
          resource.pooled &&
          capacity > 0n &&
          reason.trim() !== "",
      );
      await create(c, "rent_reservations.CapacityRevision", { parent: resource, capacity, reason });
      await set(c, resource, { capacity });
      await create(c, "rent_reservations.ResourcePolicy", {
        parent: resource,
        sequence: int64(
          (await count(records(c, "rent_reservations.ResourcePolicy", { parent: resource }))) + 1n,
        ),
        value: await resource_evidence(c, resource),
      });
      for await (const booking of records(c, "rent_reservations.Booking", {
        parent: resource,
        where: (b) => busy(c, b),
        limit: 1000n,
      })) {
        if (
          !(await free(
            c,
            resource,
            booking.reserved_from,
            booking.reserved_until,
            booking.quantity,
            booking,
          ))
        )
          await create(c, "rent_reservations.Conflict", { parent: resource, booking, reason });
      }
    },
    async assign_desk(c, { booking, desk, from, until }) {
      check(hasRole(c, "rent_reservations.reception"), "forbidden");
      check(
        (await can_work(c, c.actor, booking.parent.location)) &&
          booking.parent.pooled &&
          same(desk.parent, booking.parent) &&
          desk.active,
      );
      check(
        ["confirmed", "occupied"].includes(booking.status) &&
          compareInstant(booking.from, from) <= 0 &&
          compareInstant(from, until) < 0 &&
          compareInstant(until, booking.until) <= 0,
      );
      check(
        !(await any(
          records(c, "rent_reservations.Assignment"),
          (a) => same(a.desk, desk) && busy(c, a.parent) && overlaps(from, until, a.from, a.until),
        )),
      );
      check(
        (await count(
          records(c, "rent_reservations.Assignment", {
            parent: booking,
            where: (a) => overlaps(from, until, a.from, a.until),
          }),
        )) < booking.quantity,
      );
      await create(c, "rent_reservations.Assignment", { parent: booking, desk, from, until });
    },
    async fulfill_free(c, { booking, reason }) {
      check(hasRole(c, "authenticated") || hasRole(c, "rent_reservations.reception"), "forbidden");
      check(
        (same(booking.account, c.actor) ||
          (hasRole(c, "rent_reservations.reception") &&
            (await can_work(c, c.actor, booking.parent.location)))) &&
          booking.status === "held" &&
          compareInstant(c.now, booking.expires) < 0,
      );
      check(
        booking.total.minor === 0n && booking.allowance === "not_required" && reason.trim() !== "",
      );
      check(await bookable(c, booking));
      await set(c, booking, { status: "confirmed", payment: "free", fulfillment_reason: reason });
      await create(c, "rent_reservations.ResourcePolicy", {
        parent: booking.parent,
        sequence: int64(
          (await count(
            records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
          )) + 1n,
        ),
        value: await resource_evidence(c, booking.parent),
      });
      await cancel(c, booking.id);
      await emit(c, "rent_reservations.ReservationChanged", {
        booking,
        revision: int64(booking.version + 1n),
      });
    },
    async confirm_account(c, { booking, reason }) {
      check(
        hasRole(c, "rent_reservations.reception") || hasRole(c, "rent_reservations.billing"),
        "forbidden",
      );
      check(
        (await can_work(c, c.actor, booking.parent.location)) &&
          ["held", "pending"].includes(booking.status) &&
          compareInstant(c.now, booking.expires) < 0 &&
          reason.trim() !== "",
      );
      check(
        (await credit_allowed(c, booking.customer, booking.parent)) && (await bookable(c, booking)),
      );
      for await (const approval of records(c, "customer.BillingProfile", {
        parent: booking.customer,
        where: (p) =>
          p.on_account &&
          p.approved_locations.some((location) => same(location, booking.parent.location)),
        limit: 1n,
      }))
        await set(c, booking, {
          approval,
          approval_version: approval.version,
          payment: "on_account",
          fulfillment_reason: reason,
        });
      if (
        booking.billing_delivery === null &&
        booking.allowance === "not_required" &&
        booking.total.minor > 0n
      ) {
        const charge = await send(c, "rent_reservations.Billing.charge", {
          value: charge_request(c, booking, booking.subtotal, booking.discount, booking.tax),
        });
        await set(c, booking, { billing_delivery: charge.id, monetary_due: booking.total });
      }
      if (booking.allowance === "not_required") {
        await set(c, booking, { status: "confirmed" });
        await create(c, "rent_reservations.ResourcePolicy", {
          parent: booking.parent,
          sequence: int64(
            (await count(
              records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
            )) + 1n,
          ),
          value: await resource_evidence(c, booking.parent),
        });
        await cancel(c, booking.id);
        await emit(c, "rent_reservations.ReservationChanged", {
          booking,
          revision: int64(booking.version + 1n),
        });
      } else {
        if (booking.allowance === "pending" && booking.allowance_delivery === null) {
          const allocation = await send(c, "rent_reservations.Membership.reserve", {
            value: benefit_request(c, booking),
          });
          await set(c, booking, { status: "pending", allowance_delivery: allocation.id });
          await create(c, "rent_reservations.ResourcePolicy", {
            parent: booking.parent,
            sequence: int64(
              (await count(
                records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
              )) + 1n,
            ),
            value: await resource_evidence(c, booking.parent),
          });
        }
        if (booking.allowance === "reserved" && booking.consume_delivery === null) {
          const consume = await send(c, "rent_reservations.Membership.consume", {
            source: booking.allowance_source ?? booking.source,
            customer: booking.customer.id,
          });
          await set(c, booking, { status: "pending", consume_delivery: consume.id });
          await create(c, "rent_reservations.ResourcePolicy", {
            parent: booking.parent,
            sequence: int64(
              (await count(
                records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
              )) + 1n,
            ),
            value: await resource_evidence(c, booking.parent),
          });
        }
      }
    },
    async charge_result(c, { event }) {
      for await (const booking of records(c, "rent_reservations.Booking", {
        where: (b) => b.billing_delivery === event.delivery_id,
        limit: 1n,
      })) {
        if (
          event.status === "succeeded" &&
          event.result !== null &&
          event.result.source === booking.source &&
          event.result.reference !== null
        ) {
          await set(c, booking, { invoice: event.result.reference });
          await emit(c, "rent_reservations.ReservationChanged", {
            booking,
            revision: int64(booking.version + 1n),
          });
        }
        if (event.status === "unknown" && booking.payment === "pending") {
          await set(c, booking, { payment: "unknown" });
          await emit(c, "rent_reservations.ReservationChanged", {
            booking,
            revision: int64(booking.version + 1n),
          });
        }
        if (event.status === "failed" && ["held", "pending"].includes(booking.status)) {
          await set(c, booking, { status: "review" });
          await create(c, "rent_reservations.ResourcePolicy", {
            parent: booking.parent,
            sequence: int64(
              (await count(
                records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
              )) + 1n,
            ),
            value: await resource_evidence(c, booking.parent),
          });
          await emit(c, "rent_reservations.CommercialCheck", { booking });
        }
      }
    },
    async no_show(c, { booking, reason }) {
      check(hasRole(c, "rent_reservations.reception"), "forbidden");
      check(
        (await can_work(c, c.actor, booking.parent.location)) &&
          booking.status === "confirmed" &&
          booking.checked_in === null &&
          compareInstant(booking.until, c.now) <= 0 &&
          reason.trim() !== "",
      );
      await set(c, booking, { status: "no_show", cancellation_reason: reason });
      await create(c, "rent_reservations.ResourcePolicy", {
        parent: booking.parent,
        sequence: int64(
          (await count(
            records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
          )) + 1n,
        ),
        value: await resource_evidence(c, booking.parent),
      });
      await emit(c, "rent_reservations.ReservationChanged", {
        booking,
        revision: int64(booking.version + 1n),
      });
    },
    async adjust(c, { booking, amount, reason }) {
      check(hasRole(c, "rent_reservations.billing"), "forbidden");
      check(
        (await can_work(c, c.actor, booking.parent.location)) &&
          ["occupied", "completed", "no_show"].includes(booking.status) &&
          amount.currency === booking.total.currency &&
          amount.minor > 0n &&
          reason.trim() !== "",
      );
      const adjustment = await create(c, "rent_reservations.Adjustment", {
        parent: booking,
        source: c.operation.id,
        amount,
        reason,
      });
      const charge = await send(c, "rent_reservations.Billing.charge", {
        value: {
          source: adjustment.source,
          customer: booking.customer.id,
          location: booking.parent.location.id,
          description: reason,
          amount,
          due: local_date(c.now, booking.parent.timezone),
        },
      });
      await set(c, adjustment, { delivery: charge.id });
    },
    async extend(c, { booking, until, reason, amount = null }) {
      check(
        hasRole(c, "authenticated") ||
          hasRole(c, "rent_reservations.reception") ||
          hasRole(c, "rent_reservations.billing"),
        "forbidden",
      );
      check(
        (same(booking.account, c.actor) ||
          ((hasRole(c, "rent_reservations.reception") || hasRole(c, "rent_reservations.billing")) &&
            (await can_work(c, c.actor, booking.parent.location)))) &&
          ["confirmed", "occupied"].includes(booking.status) &&
          booking.allowance === "not_required" &&
          !booking.intervals.length &&
          compareInstant(booking.until, until) < 0 &&
          durationBetween(until, booking.until) % booking.parent.increment === 0n &&
          reason.trim() !== "",
      );
      check(
        (booking.quote === null && amount === null) ||
          (booking.quote !== null &&
            hasRole(c, "rent_reservations.billing") &&
            (await can_work(c, c.actor, booking.parent.location)) &&
            amount !== null &&
            amount.currency === booking.total.currency &&
            amount.minor > 0n),
      );
      for await (const adjustment of records(c, "rent_reservations.Adjustment", {
        parent: booking,
      }))
        check(!(adjustment.new_until !== null && adjustment.state === "pending"));
      check(
        await free(
          c,
          booking.parent,
          booking.reserved_from,
          addDuration(until, booking.departure_buffer),
          booking.quantity,
          booking,
        ),
      );
      const extra =
        amount ??
        multiplyMoney(
          multiplyMoney(
            multiplyMoney(
              multiplyMoney(
                booking.rate,
                divideDecimal(durationBetween(until, booking.until), 3600000n),
              ),
              booking.quantity,
            ),
            subtractDecimal("1", booking.discount_fraction),
          ),
          addDecimal("1", booking.tax_fraction),
        );
      check(extra.minor > 0n);
      const adjustment = await create(c, "rent_reservations.Adjustment", {
        parent: booking,
        source: c.operation.id,
        amount: extra,
        reason,
        original_until: booking.until,
        original_reserved_until: booking.reserved_until,
        new_until: until,
        expires: addDuration(c.now, booking.parent.hold_for),
      });
      await set(c, booking, { reserved_until: addDuration(until, booking.departure_buffer) });
      const charge = await send(c, "rent_reservations.Billing.charge", {
        value: {
          source: adjustment.source,
          customer: booking.customer.id,
          location: booking.parent.location.id,
          description: reason,
          amount: extra,
          due: local_date(c.now, booking.parent.timezone),
        },
      });
      await set(c, adjustment, { delivery: charge.id });
      await schedule(c, adjustment.id, adjustment.expires, "rent_reservations.AdjustmentDue", {
        adjustment,
      });
    },
    async adjustment_money(c, { event }) {
      for await (const adjustment of records(c, "rent_reservations.Adjustment", {
        where: (a) => a.source === event.value.source,
        limit: 1n,
      })) {
        check(equalMoney(event.value.amount, adjustment.amount));
        const fresh = event.value.revision > adjustment.settlement_revision;
        if (fresh)
          await set(c, adjustment, {
            settlement_revision: event.value.revision,
            collected: event.value.collected,
            refunded: event.value.refunded,
            invoice: event.value.invoice,
          });
        if (
          fresh &&
          compareMoney(
            subtractMoney(event.value.collected, event.value.refunded),
            adjustment.amount,
          ) >= 0 &&
          ["pending", "expired"].includes(adjustment.state)
        ) {
          await set(c, adjustment, { invoice: event.value.invoice });
          if (
            adjustment.movement !== null &&
            ["cancelled", "cancelling", "review"].includes(adjustment.movement.state)
          )
            await set(c, adjustment, { state: "review" });
          else if (adjustment.new_until === null) await set(c, adjustment, { state: "paid" });
          else if (
            ["confirmed", "occupied"].includes(adjustment.parent.status) &&
            equalValue(c, "datetime", adjustment.parent.until, adjustment.original_until) &&
            (await free(
              c,
              adjustment.parent.parent,
              adjustment.parent.reserved_from,
              addDuration(adjustment.new_until, adjustment.parent.departure_buffer),
              adjustment.parent.quantity,
              adjustment.parent,
            ))
          ) {
            await set(c, adjustment.parent, {
              until: adjustment.new_until,
              reserved_until: addDuration(adjustment.new_until, adjustment.parent.departure_buffer),
            });
            await create(c, "rent_reservations.ResourcePolicy", {
              parent: adjustment.parent.parent,
              sequence: int64(
                (await count(
                  records(c, "rent_reservations.ResourcePolicy", {
                    parent: adjustment.parent.parent,
                  }),
                )) + 1n,
              ),
              value: await resource_evidence(c, adjustment.parent.parent),
            });
            await set(c, adjustment, { state: "paid" });
            await cancel(c, adjustment.id);
            await emit(c, "rent_reservations.ReservationChanged", {
              booking: adjustment.parent,
              revision: int64(adjustment.parent.version + 1n),
            });
          } else {
            await set(c, adjustment, { state: "review" });
            if (
              equalValue(c, "datetime", adjustment.parent.until, adjustment.original_until) &&
              equalValue(
                c,
                "datetime",
                adjustment.parent.reserved_until,
                addDuration(adjustment.new_until, adjustment.parent.departure_buffer),
              )
            )
              await set(c, adjustment.parent, {
                reserved_until: adjustment.original_reserved_until,
              });
          }
        }
        if (
          fresh &&
          adjustment.refund_delivery !== null &&
          compareMoney(event.value.refunded, adjustment.amount) >= 0
        )
          await set(c, adjustment, { state: "refunded" });
      }
    },
    async extension_expire(c, { event }) {
      const adjustment = event.adjustment;
      check(
        adjustment.state === "pending" &&
          adjustment.expires !== null &&
          compareInstant(adjustment.expires, c.now) <= 0,
      );
      await set(c, adjustment, { state: "expired" });
      if (
        equalValue(c, "datetime", adjustment.parent.until, adjustment.original_until) &&
        equalValue(
          c,
          "datetime",
          adjustment.parent.reserved_until,
          addDuration(adjustment.new_until, adjustment.parent.departure_buffer),
        )
      )
        await set(c, adjustment.parent, { reserved_until: adjustment.original_reserved_until });
      await send(c, "rent_reservations.Billing.cancel", {
        source: adjustment.source,
        reason: "Extension hold expired",
      });
    },
    async refund_adjustment(c, { adjustment, reason }) {
      check(hasRole(c, "rent_reservations.billing"), "forbidden");
      check(
        (await can_work(c, c.actor, adjustment.parent.parent.location)) &&
          adjustment.state === "review" &&
          adjustment.refund_delivery === null &&
          reason.trim() !== "",
      );
      const refund = await send(c, "rent_reservations.Billing.refund", {
        source: adjustment.source,
        amount: adjustment.amount,
        reason,
      });
      await set(c, adjustment, { refund_delivery: refund.id });
    },
    async refund_review(c, { booking, reason }) {
      check(hasRole(c, "rent_reservations.billing"), "forbidden");
      check(
        (await can_work(c, c.actor, booking.parent.location)) &&
          booking.payment === "paid" &&
          ["review", "expired", "cancelled"].includes(booking.status) &&
          booking.refund_delivery === null &&
          reason.trim() !== "",
      );
      const restore =
        booking.status === "expired" || compareInstant(c.now, booking.refund_before) < 0;
      await set(c, booking, { status: "cancelled", cancellation_reason: reason });
      await create(c, "rent_reservations.ResourcePolicy", {
        parent: booking.parent,
        sequence: int64(
          (await count(
            records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
          )) + 1n,
        ),
        value: await resource_evidence(c, booking.parent),
      });
      if (booking.allowance !== "not_required" && booking.release_delivery === null) {
        const release = await send(c, "rent_reservations.Membership.release", {
          source: booking.allowance_source ?? booking.source,
          customer: booking.customer.id,
          restore_consumed: restore,
        });
        await set(c, booking, { release_delivery: release.id });
      }
      const refund = await send(c, "rent_reservations.Billing.refund", {
        source: booking.source,
        amount: booking.monetary_due ?? booking.total,
        reason,
      });
      await set(c, booking, {
        refund_delivery: refund.id,
        refund_state: "pending",
        refund_requested: booking.monetary_due ?? booking.total,
      });
      await emit(c, "rent_reservations.ReservationChanged", {
        booking,
        revision: int64(booking.version + 1n),
      });
    },
    async resolve_conflict(c, { conflict, evidence }) {
      check(hasRole(c, "rent_reservations.reservation_manager"), "forbidden");
      check(
        (await can_work(c, c.actor, conflict.parent.location)) &&
          !conflict.resolved &&
          evidence.trim() !== "",
      );
      check(
        !busy(c, conflict.booking) ||
          (await free(
            c,
            conflict.parent,
            conflict.booking.reserved_from,
            conflict.booking.reserved_until,
            conflict.booking.quantity,
            conflict.booking,
          )),
      );
      await set(c, conflict, { resolved: true, resolution: evidence });
    },
    async createDesk(c, input) {
      check(hasRole(c, "rent_reservations.reservation_manager"), "forbidden");
      await create(c, "rent_reservations.Desk", input, { when: crudWhen.Desk });
    },
    async updateDesk(c, { record, changes }) {
      check(hasRole(c, "rent_reservations.reservation_manager"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Desk });
    },
    async commercial_changed(c, { event }) {
      await emit(c, "rent_reservations.CommercialCheck", { booking: event.booking });
    },
    async commercial_check(c, { event }) {
      const booking = event.booking;
      if (
        booking.billing_location !== null &&
        booking.sale_product !== null &&
        booking.purchased_at !== null &&
        booking.monetary_due !== null &&
        booking.monetary_due.minor > 0n &&
        booking.billing_delivery !== null
      ) {
        if (
          !(await any(
            records(c, "rent_reservations.CommercialSale", { parent: booking }),
            () => true,
          ))
        )
          await create(c, "rent_reservations.CommercialSale", { parent: booking });
        const sale = await first(
          records(c, "rent_reservations.CommercialSale", {
            parent: booking,
            order: [["id", "asc"]],
          }),
        );
        check(sale !== null);
        if (sale.phase !== "reversed") {
          if (
            ["cancelled", "no_show"].includes(booking.status) ||
            booking.cancel_delivery !== null ||
            booking.cancellation_reason !== null ||
            booking.refund_delivery !== null ||
            booking.refund_requested !== null ||
            (booking.refunded !== null && booking.refunded.minor > 0n) ||
            (sale.phase !== null &&
              (["review", "expired"].includes(booking.status) ||
                booking.payment !== "paid" ||
                !["not_required", "consumed"].includes(booking.allowance)))
          ) {
            await set(c, sale, { phase: "reversed", revision: int64(sale.revision + 1n) });
            await emit(c, "rent_reservations.CommercialSaleChanged", {
              value: commercial(
                c,
                booking,
                sale,
                booking.billing_location,
                booking.sale_product,
                booking.monetary_due,
                booking.purchased_at,
                "reversed",
                c.now,
              ),
            });
          } else if (
            booking.payment === "paid" &&
            ["confirmed", "occupied", "completed"].includes(booking.status) &&
            ["not_required", "consumed"].includes(booking.allowance) &&
            booking.cancel_delivery === null &&
            !booking.collection_pending &&
            !booking.refund_pending &&
            booking.refund_state === "none" &&
            booking.collected !== null &&
            compareMoney(booking.collected, booking.monetary_due) >= 0 &&
            booking.refunded !== null &&
            booking.refunded.minor === 0n
          ) {
            if (booking.status === "completed" && booking.checked_out !== null) {
              if (sale.phase !== "completed") {
                await set(c, sale, { phase: "completed", revision: int64(sale.revision + 1n) });
                await emit(c, "rent_reservations.CommercialSaleChanged", {
                  value: commercial(
                    c,
                    booking,
                    sale,
                    booking.billing_location,
                    booking.sale_product,
                    booking.monetary_due,
                    booking.purchased_at,
                    "completed",
                    booking.checked_out,
                  ),
                });
              }
            } else if (sale.phase === null) {
              await set(c, sale, { phase: "paid", revision: int64(sale.revision + 1n) });
              await emit(c, "rent_reservations.CommercialSaleChanged", {
                value: commercial(
                  c,
                  booking,
                  sale,
                  booking.billing_location,
                  booking.sale_product,
                  booking.monetary_due,
                  booking.purchased_at,
                  "paid",
                  c.now,
                ),
              });
            }
          }
        }
      }
    },
    async correspondence(c, { event }) {
      const { booking, revision } = event;
      check(booking.version === revision);
      await cancel(c, booking.source);
      if (booking.status === "confirmed") {
        const subject = format(c, message("Workspace confirmed", { nl: "Werkplek bevestigd" }), {
            locale: null,
          }),
          body = format(
            c,
            message(
              "{location}; {resource}; {from,date} {from,time} – {until,date} {until,time}; {arrival}; {terms}; /workspace/my-bookings",
              {
                nl: "{location}; {resource}; {from,date} {from,time} – {until,date} {until,time}; {arrival}; {terms}; /workspace/my-bookings",
              },
              {
                location: { type: "text", value: booking.parent.location.name },
                resource: { type: "text", value: booking.parent.name },
                from: { type: "datetime", value: booking.from },
                until: { type: "datetime", value: booking.until },
                arrival: { type: "text", value: booking.parent.location.arrival },
                terms: { type: "text", value: booking.terms },
              },
            ),
            { locale: null },
          );
        const delivery = await send(
          c,
          "rent_reservations.Mail.send",
          { to: booking.email, subject, body },
          { when: () => booking.status === "confirmed" && booking.version === revision },
        );
        await create(c, "rent_reservations.Notice", {
          parent: booking,
          kind: "confirmation",
          revision,
          subject,
          body,
          delivery,
        });
        if (compareInstant(booking.from, addDuration(c.now, 3600000n)) > 0)
          await schedule(
            c,
            booking.source,
            subtractDuration(booking.from, 3600000n),
            "rent_reservations.Reminder",
            { booking, revision },
          );
      }
      if (["cancelled", "expired", "no_show"].includes(booking.status)) {
        const subject = format(
            c,
            message("Workspace booking changed", { nl: "Werkplekreservering gewijzigd" }),
            { locale: null },
          ),
          body = booking.terms;
        const delivery = await send(
          c,
          "rent_reservations.Mail.send",
          { to: booking.email, subject, body },
          { when: () => booking.version === revision },
        );
        await create(c, "rent_reservations.Notice", {
          parent: booking,
          kind: "cancellation",
          revision,
          subject,
          body,
          delivery,
        });
      }
    },
    async remind(c, { event }) {
      const { booking, revision } = event;
      check(booking.status === "confirmed" && booking.version === revision);
      const subject = format(
          c,
          message("Workspace arrival reminder", { nl: "Herinnering werkplekaankomst" }),
          { locale: null },
        ),
        body = booking.parent.location.arrival;
      const delivery = await send(
        c,
        "rent_reservations.Mail.send",
        { to: booking.email, subject, body },
        { when: () => booking.status === "confirmed" && booking.version === revision },
      );
      await create(c, "rent_reservations.Notice", {
        parent: booking,
        kind: "reminder",
        revision,
        subject,
        body,
        delivery,
      });
    },
    async resend_notice(c, { notice }) {
      check(hasRole(c, "authenticated") || hasRole(c, "rent_reservations.reception"), "forbidden");
      check(
        same(notice.parent.account, c.actor) ||
          (hasRole(c, "rent_reservations.reception") &&
            (await can_work(c, c.actor, notice.parent.parent.location))),
      );
      check(
        ["failed", "unknown"].includes(
          (await delivery(c, { record: notice, field: "delivery" }, ["status"])).status,
        ) && notice.parent.version === notice.revision,
      );
      const attempt = await send(c, "rent_reservations.Mail.send", {
        to: notice.parent.email,
        subject: notice.subject,
        body: notice.body,
      });
      await set(c, notice, { delivery: attempt });
    },
    async allowance_result(c, { event }) {
      for await (const booking of records(c, "rent_reservations.Booking", {
        where: (b) => b.allowance_delivery === event.delivery_id,
        limit: 1n,
      })) {
        if (
          event.status === "succeeded" &&
          event.result !== null &&
          event.result.source === (booking.allowance_source ?? booking.source)
        )
          await emit(c, "rent_reservations.AllowanceObserved", { booking, value: event.result });
        if (
          event.status === "failed" &&
          booking.allowance === "pending" &&
          ["held", "pending", "review"].includes(booking.status)
        ) {
          await set(c, booking, { allowance: "failed", status: "review" });
          await create(c, "rent_reservations.ResourcePolicy", {
            parent: booking.parent,
            sequence: int64(
              (await count(
                records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
              )) + 1n,
            ),
            value: await resource_evidence(c, booking.parent),
          });
          const release = await send(c, "rent_reservations.Membership.release", {
            source: booking.allowance_source ?? booking.source,
            customer: booking.customer.id,
            restore_consumed: false,
          });
          await set(c, booking, { release_delivery: release.id });
          const cancellation = await send(c, "rent_reservations.Billing.cancel", {
            source: booking.source,
            reason: "Allowance unavailable",
          });
          await set(c, booking, { cancel_delivery: cancellation.id });
          await emit(c, "rent_reservations.CommercialCheck", { booking });
        }
      }
    },
    async reconcile_allowance(c, { booking }) {
      check(hasRole(c, "authenticated") || hasRole(c, "rent_reservations.reception"), "forbidden");
      check(
        same(booking.account, c.actor) ||
          (hasRole(c, "rent_reservations.reception") &&
            (await can_work(c, c.actor, booking.parent.location))),
      );
      check(booking.allowance !== "not_required");
      const reconciliation = await send(c, "rent_reservations.Membership.reconcile", {
        source: booking.allowance_source ?? booking.source,
        customer: booking.customer.id,
      });
      await set(c, booking, { allowance_reconcile_delivery: reconciliation.id });
    },
    async allowance_reconciled(c, { event }) {
      for await (const booking of records(c, "rent_reservations.Booking", {
        where: (b) => b.allowance_reconcile_delivery === event.delivery_id,
        limit: 1n,
      }))
        if (
          event.status === "succeeded" &&
          event.result !== null &&
          event.result.source === (booking.allowance_source ?? booking.source)
        )
          await emit(c, "rent_reservations.AllowanceObserved", { booking, value: event.result });
    },
    async allowance_changed(c, { event }) {
      for await (const booking of records(c, "rent_reservations.Booking", {
        where: (b) => (b.allowance_source ?? b.source) === event.value.source,
        limit: 1n,
      })) {
        let replacing = false;
        for await (const movement of records(c, "rent_reservations.Movement", { parent: booking }))
          if (movement.state === "committing") replacing = true;
        if (event.value.phase !== "released" || !replacing)
          await emit(c, "rent_reservations.AllowanceObserved", { booking, value: event.value });
      }
    },
    async allowance_snapshot(c, { event }) {
      const booking = event.booking;
      check(
        event.value.source === (booking.allowance_source ?? booking.source) &&
          event.value.revision > booking.allowance_revision,
      );
      check(
        event.value.state !== "confirmed" ||
          event.value.phase === "released" ||
          (event.value.unit === booking.benefit_unit &&
            event.value.duration === booking.benefit_duration &&
            equalMoney(event.value.rate, booking.benefit_rate ?? booking.rate)),
      );
      if (event.value.state === "confirmed" && event.value.phase === "reserved") {
        if (
          ["cancelled", "expired", "completed", "no_show"].includes(booking.status) ||
          compareInstant(booking.expires, c.now) <= 0 ||
          !(await bookable(c, booking))
        ) {
          if (["held", "pending"].includes(booking.status)) {
            await set(c, booking, { status: "review" });
            await create(c, "rent_reservations.ResourcePolicy", {
              parent: booking.parent,
              sequence: int64(
                (await count(
                  records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
                )) + 1n,
              ),
              value: await resource_evidence(c, booking.parent),
            });
          }
          if (booking.release_delivery === null) {
            const release = await send(c, "rent_reservations.Membership.release", {
              source: booking.allowance_source ?? booking.source,
              customer: booking.customer.id,
              restore_consumed:
                booking.status === "expired" || compareInstant(c.now, booking.refund_before) < 0,
            });
            await set(c, booking, { release_delivery: release.id });
          }
        } else if (booking.allowance === "pending") {
          check(
            event.value.phase === "reserved" &&
              event.value.unit === booking.benefit_unit &&
              event.value.duration === benefit_request(c, booking).duration &&
              equalMoney(event.value.rate, benefit_request(c, booking).rate),
          );
          const discount = multiplyMoney(event.value.overage, booking.discount_fraction),
            tax = multiplyMoney(subtractMoney(event.value.overage, discount), booking.tax_fraction),
            balance = addMoney(subtractMoney(event.value.overage, discount), tax);
          await set(c, booking, {
            allowance_base: event.value.overage,
            allowance_discount: discount,
            allowance_tax: tax,
            service_due: balance,
            allowance: "reserved",
            allowance_units: event.value.units,
            included_units: event.value.covered_units,
            allowance_revision: event.value.revision,
            monetary_due: balance,
          });
          if (balance.minor === 0n)
            await set(c, booking, {
              payment: "free",
              fulfillment_reason: "Included membership units",
            });
          else if (booking.billing_delivery === null) {
            const charge = await send(c, "rent_reservations.Billing.charge", {
              value: charge_request(c, booking, event.value.overage, discount, tax),
            });
            await set(c, booking, { billing_delivery: charge.id });
            if (booking.payment !== "on_account") await set(c, booking, { payment: "pending" });
          }
          if (
            ["paid", "free", "on_account"].includes(booking.payment) &&
            ["pending", "review"].includes(booking.status)
          ) {
            if ((await bookable(c, booking)) && booking.consume_delivery === null) {
              const consume = await send(c, "rent_reservations.Membership.consume", {
                source: booking.allowance_source ?? booking.source,
                customer: booking.customer.id,
              });
              await set(c, booking, { status: "pending", consume_delivery: consume.id });
              await create(c, "rent_reservations.ResourcePolicy", {
                parent: booking.parent,
                sequence: int64(
                  (await count(
                    records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
                  )) + 1n,
                ),
                value: await resource_evidence(c, booking.parent),
              });
            } else {
              await set(c, booking, { status: "review", refund_state: "review" });
              await create(c, "rent_reservations.ResourcePolicy", {
                parent: booking.parent,
                sequence: int64(
                  (await count(
                    records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
                  )) + 1n,
                ),
                value: await resource_evidence(c, booking.parent),
              });
            }
          }
        }
      }
      if (event.value.phase === "consumed" && event.value.state === "confirmed") {
        await set(c, booking, { allowance: "consumed" });
        if (
          ["pending", "review"].includes(booking.status) &&
          ["paid", "free", "on_account"].includes(booking.payment) &&
          booking.release_delivery === null
        ) {
          if (
            (await bookable(c, booking)) &&
            (booking.payment !== "paid" || (await financial_cover(c, booking)))
          ) {
            await set(c, booking, { status: "confirmed" });
            await create(c, "rent_reservations.ResourcePolicy", {
              parent: booking.parent,
              sequence: int64(
                (await count(
                  records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
                )) + 1n,
              ),
              value: await resource_evidence(c, booking.parent),
            });
            await cancel(c, booking.id);
            await emit(c, "rent_reservations.ReservationChanged", {
              booking,
              revision: int64(booking.version + 1n),
            });
          } else {
            await set(c, booking, { status: "review", refund_state: "review" });
            await create(c, "rent_reservations.ResourcePolicy", {
              parent: booking.parent,
              sequence: int64(
                (await count(
                  records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
                )) + 1n,
              ),
              value: await resource_evidence(c, booking.parent),
            });
          }
        }
      }
      if (event.value.phase === "released") {
        await set(c, booking, { allowance: "released" });
        if (["held", "pending", "confirmed"].includes(booking.status)) {
          await set(c, booking, { status: "review" });
          await create(c, "rent_reservations.ResourcePolicy", {
            parent: booking.parent,
            sequence: int64(
              (await count(
                records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
              )) + 1n,
            ),
            value: await resource_evidence(c, booking.parent),
          });
        }
      }
      await set(c, booking, { allowance_revision: event.value.revision });
      await emit(c, "rent_reservations.CommercialCheck", { booking });
    },
    async settlement_received(c, { event }) {
      await emit(c, "rent_reservations.SettlementObserved", { value: event.value });
    },
    async reconcile_booking(c, { booking }) {
      check(
        hasRole(c, "authenticated") ||
          hasRole(c, "rent_reservations.reception") ||
          hasRole(c, "rent_reservations.billing"),
        "forbidden",
      );
      check(
        same(booking.account, c.actor) ||
          ((hasRole(c, "rent_reservations.reception") || hasRole(c, "rent_reservations.billing")) &&
            (await can_work(c, c.actor, booking.parent.location))),
      );
      const reconciliation = await send(c, "rent_reservations.Billing.reconcile", {
        source: booking.source,
      });
      await set(c, booking, { reconcile_delivery: reconciliation.id });
    },
    async reconciled(c, { event }) {
      for await (const booking of records(c, "rent_reservations.Booking", {
        where: (row) => row.reconcile_delivery === event.delivery_id,
        limit: 1n,
      })) {
        if (event.status === "succeeded" && event.result !== null) {
          check(event.result.source === booking.source);
          await emit(c, "rent_reservations.SettlementObserved", { value: event.result });
        }
        if (["failed", "unknown"].includes(event.status))
          await set(c, booking, { refund_state: "unknown" });
      }
    },
    async money(c, { event }) {
      for await (const booking of records(c, "rent_reservations.Booking", {
        where: (b) => b.source === event.value.source,
        limit: 1n,
      })) {
        check(
          equalMoney(event.value.amount, booking.monetary_due ?? booking.total) &&
            event.value.collected.currency === booking.total.currency &&
            event.value.refunded.currency === booking.total.currency,
        );
        if (event.value.revision <= booking.settlement_revision) continue;
        await set(c, booking, {
          settlement_revision: event.value.revision,
          invoice: event.value.invoice,
          collected: event.value.collected,
          refunded: event.value.refunded,
          collection_pending: event.value.collection_pending,
          refund_pending: event.value.refund_pending,
        });
        if (
          compareMoney(
            subtractMoney(event.value.collected, event.value.refunded),
            booking.monetary_due ?? booking.total,
          ) >= 0 &&
          event.value.amount.minor > 0n
        ) {
          await set(c, booking, { payment: "paid" });
          if (["cancelled", "no_show", "completed", "occupied"].includes(booking.status)) {
            if (["cancelled", "no_show"].includes(booking.status))
              await set(c, booking, { refund_state: "review" });
          } else if (
            event.value.state === "issued" &&
            !event.value.refund_pending &&
            event.value.refunded.minor === 0n &&
            booking.cancel_delivery === null &&
            booking.refund_delivery === null &&
            booking.refund_requested === null &&
            booking.release_delivery === null &&
            compareInstant(c.now, booking.until) < 0 &&
            (await bookable(c, booking))
          ) {
            if (["not_required", "consumed"].includes(booking.allowance)) {
              await set(c, booking, { status: "confirmed", refund_state: "none" });
              await create(c, "rent_reservations.ResourcePolicy", {
                parent: booking.parent,
                sequence: int64(
                  (await count(
                    records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
                  )) + 1n,
                ),
                value: await resource_evidence(c, booking.parent),
              });
              await cancel(c, booking.id);
            } else if (booking.allowance === "reserved" && booking.consume_delivery === null) {
              const consume = await send(c, "rent_reservations.Membership.consume", {
                source: booking.allowance_source ?? booking.source,
                customer: booking.customer.id,
              });
              await set(c, booking, {
                status: "pending",
                expires: addDuration(c.now, booking.parent.hold_for),
                consume_delivery: consume.id,
              });
              await create(c, "rent_reservations.ResourcePolicy", {
                parent: booking.parent,
                sequence: int64(
                  (await count(
                    records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
                  )) + 1n,
                ),
                value: await resource_evidence(c, booking.parent),
              });
              await schedule(c, booking.id, booking.expires, "rent_reservations.HoldDue", {
                booking,
              });
            } else if (booking.allowance === "pending") {
              await set(c, booking, {
                status: "pending",
                expires: addDuration(c.now, booking.parent.hold_for),
              });
              await create(c, "rent_reservations.ResourcePolicy", {
                parent: booking.parent,
                sequence: int64(
                  (await count(
                    records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
                  )) + 1n,
                ),
                value: await resource_evidence(c, booking.parent),
              });
              await schedule(c, booking.id, booking.expires, "rent_reservations.HoldDue", {
                booking,
              });
            } else {
              await set(c, booking, { status: "review", refund_state: "review" });
              await create(c, "rent_reservations.ResourcePolicy", {
                parent: booking.parent,
                sequence: int64(
                  (await count(
                    records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
                  )) + 1n,
                ),
                value: await resource_evidence(c, booking.parent),
              });
            }
          } else {
            await set(c, booking, { status: "review", refund_state: "review" });
            await create(c, "rent_reservations.ResourcePolicy", {
              parent: booking.parent,
              sequence: int64(
                (await count(
                  records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
                )) + 1n,
              ),
              value: await resource_evidence(c, booking.parent),
            });
          }
        }
        if (
          booking.refund_requested !== null &&
          compareMoney(event.value.refunded, booking.refund_requested) >= 0
        ) {
          await set(c, booking, { refund_state: "refunded" });
          if (compareMoney(event.value.refunded, event.value.collected) >= 0)
            await set(c, booking, { payment: "refunded" });
        }
        if (event.value.refund_pending && booking.refund_state !== "refunded")
          await set(c, booking, { refund_state: "pending" });
        if (
          ["void_pending", "void"].includes(event.value.state) &&
          ["held", "pending", "confirmed"].includes(booking.status)
        ) {
          await set(c, booking, { status: "review" });
          await create(c, "rent_reservations.ResourcePolicy", {
            parent: booking.parent,
            sequence: int64(
              (await count(
                records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
              )) + 1n,
            ),
            value: await resource_evidence(c, booking.parent),
          });
        }
        await emit(c, "rent_reservations.ReservationChanged", {
          booking,
          revision: int64(booking.version + 1n),
        });
      }
    },
    async consumption(c, { event }) {
      for await (const booking of records(c, "rent_reservations.Booking", {
        where: (b) => b.consume_delivery === event.delivery_id,
        limit: 1n,
      })) {
        if (
          event.status === "succeeded" &&
          event.result !== null &&
          event.result.source === (booking.allowance_source ?? booking.source) &&
          event.result.state === "confirmed" &&
          event.result.phase === "consumed"
        )
          await emit(c, "rent_reservations.AllowanceObserved", { booking, value: event.result });
        if (
          ["failed", "unknown"].includes(event.status) &&
          ["pending", "review"].includes(booking.status)
        ) {
          await set(c, booking, { status: "review", refund_state: "review" });
          await create(c, "rent_reservations.ResourcePolicy", {
            parent: booking.parent,
            sequence: int64(
              (await count(
                records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
              )) + 1n,
            ),
            value: await resource_evidence(c, booking.parent),
          });
          await emit(c, "rent_reservations.CommercialCheck", { booking });
        }
      }
    },
    async released(c, { event }) {
      for await (const booking of records(c, "rent_reservations.Booking", {
        where: (b) => b.release_delivery === event.delivery_id,
        limit: 1n,
      })) {
        if (
          event.status === "succeeded" &&
          event.result !== null &&
          event.result.source === (booking.allowance_source ?? booking.source) &&
          event.result.state === "released"
        ) {
          await set(c, booking, { allowance: "released" });
          await emit(c, "rent_reservations.CommercialCheck", { booking });
        } else if (["failed", "unknown"].includes(event.status))
          await set(c, booking, { refund_state: "review" });
      }
    },
    async refund_result(c, { event }) {
      for await (const booking of records(c, "rent_reservations.Booking", {
        where: (b) => b.refund_delivery === event.delivery_id,
        limit: 1n,
      })) {
        if (["failed", "unknown"].includes(event.status))
          await set(c, booking, { refund_state: "unknown" });
      }
    },
    async expire(c, { event }) {
      const booking = event.booking;
      check(
        compareInstant(booking.expires, c.now) <= 0 && ["held", "pending"].includes(booking.status),
      );
      await set(c, booking, { status: "expired" });
      await create(c, "rent_reservations.ResourcePolicy", {
        parent: booking.parent,
        sequence: int64(
          (await count(
            records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }),
          )) + 1n,
        ),
        value: await resource_evidence(c, booking.parent),
      });
      if (booking.allowance !== "not_required" && booking.release_delivery === null) {
        const release = await send(c, "rent_reservations.Membership.release", {
          source: booking.allowance_source ?? booking.source,
          customer: booking.customer.id,
          restore_consumed: true,
        });
        await set(c, booking, { release_delivery: release.id });
      }
      if (booking.payment === "paid") await set(c, booking, { refund_state: "review" });
      else if (["pending", "unknown"].includes(booking.payment) || booking.collection_pending) {
        const reconciliation = await send(c, "rent_reservations.Billing.reconcile", {
          source: booking.source,
        });
        await set(c, booking, { reconcile_delivery: reconciliation.id });
      } else {
        const cancellation = await send(c, "rent_reservations.Billing.cancel", {
          source: booking.source,
          reason: "Hold expired",
        });
        await set(c, booking, { cancel_delivery: cancellation.id });
      }
      await emit(c, "rent_reservations.ReservationChanged", {
        booking,
        revision: int64(booking.version + 1n),
      });
    },
    async request(c, { booking, use_allowance = false }) {
      check(hasRole(c, "authenticated") || hasRole(c, "rent_reservations.reception"), "forbidden");
      check(
        (same(booking.account, c.actor) ||
          (hasRole(c, "rent_reservations.reception") &&
            (await can_work(c, c.actor, booking.parent.location)))) &&
          booking.status === "held",
      );
      await call(c, "rent_reservations.prepare", { booking, use_allowance });
    },
    async check_in(c, { booking }) {
      check(hasRole(c, "rent_reservations.reception"), "forbidden");
      check(
        (await can_work(c, c.actor, booking.parent.location)) &&
          booking.status === "confirmed" &&
          ["paid", "free", "on_account"].includes(booking.payment) &&
          ["not_required", "consumed"].includes(booking.allowance),
      );
      await call(c, "rent_reservations.arrive", { booking });
    },
    async check_out(c, { booking }) {
      check(hasRole(c, "rent_reservations.reception"), "forbidden");
      check(
        (await can_work(c, c.actor, booking.parent.location)) &&
          booking.checked_in !== null &&
          booking.checked_out === null,
      );
      await call(c, "rent_reservations.depart", { booking });
    },
    async cancel(c, { booking, reason }) {
      check(hasRole(c, "authenticated") || hasRole(c, "rent_reservations.reception"), "forbidden");
      check(
        (same(booking.account, c.actor) ||
          (hasRole(c, "rent_reservations.reception") &&
            (await can_work(c, c.actor, booking.parent.location)))) &&
          reason.trim() !== "",
      );
      await call(c, "rent_reservations.cancel_booking", { booking, reason });
    },
  };
}

/* Proposed shared server UI contract: renderPage resolves one page to the shared
 * shell or authorized partial response. Lower-case factories accept one props
 * object; children arrays retain lexical record scope, renderRow uses the protected
 * row/view context, and forms/actions resolve the canonical owning operation.
 * The library owns daisyUI elements/classes, escaping, current row/field grants,
 * bounded collection queries, default HTMX routing/swaps/pending controls, history
 * projection, focus and error states. No hook component is called directly.
 * Async renderRow/data preparation is unresolved shared library work: no serializer
 * or promise handling is implemented here, and syntax checks do not verify it.
 */
export async function workspaceCatalogPage(c, bindings) {
  return renderPage(
    c,
    workspaceCatalogPageDescriptor,
    () => [
      card({
        context: c,
        title: message("Location catalog", { nl: "Locatiecatalogus" }),
        children: [
          form({ context: c, operation: "rent_catalog.Location.create" }),
          table({
            context: c,
            model: "rent_catalog.Location",
            columns: ["name", "address", "timezone", "currency", "hours"],
            renderRow: (row, view) => [
              edit({ context: view, operation: "rent_catalog.Location.update", record: row }),
              details({
                context: view,
                caption: message("Arrival information", { nl: "Aankomstinformatie" }),
                open: c.preferences.rent_catalog_ui.arrival_open,
                children: [text({ context: view, values: [row.arrival] })],
              }),
              ...[
                ["WeeklyHours", ["weekday", "opens", "closes", "close_after"]],
                ["ClosedDate", ["day", "reason"]],
                ["DateHours", ["day", "opens", "closes", "close_after", "closed"]],
              ].flatMap(([model, columns]) => [
                form({
                  context: view,
                  operation: `rent_catalog.${model}.create`,
                  arguments: { parent: row },
                }),
                table({
                  context: view,
                  model: `rent_catalog.${model}`,
                  parent: row,
                  columns,
                  renderRow: (record, rowView) => [
                    edit({ context: rowView, operation: `rent_catalog.${model}.update`, record }),
                  ],
                }),
              ]),
              history({ context: view, record: row }),
            ],
          }),
        ],
      }),
    ],
  );
}

export async function resourceCatalogPage(c, bindings) {
  return renderPage(
    c,
    resourceCatalogPageDescriptor,
    () => [
      card({
        context: c,
        title: message("Resource catalog and rates", { nl: "Voorzieningencatalogus en tarieven" }),
        children: [
          form({ context: c, operation: "rent_reservations.Resource.create" }),
          table({
            context: c,
            model: "rent_reservations.Resource",
            columns: [
              "location",
              "name",
              "capacity",
              "hourly",
              "increment",
              "minimum",
              "terms",
              "refund_notice",
              "active",
            ],
            filter: ["location"],
            defaults: { location: c.preferences.rent_reservations.location },
            display: "split",
            renderRow: (row, view) => [
              edit({ context: view, operation: "rent_reservations.Resource.update", record: row }),
              details({
                context: view,
                caption: policyTitle,
                children: [
                  text({
                    context: view,
                    values: [row.amenities, row.accessibility, row.buffer_before, row.buffer_after],
                  }),
                ],
              }),
              history({ context: view, record: row }),
            ],
          }),
        ],
      }),
    ],
  );
}

export async function workspacePage(c, bindings) {
  return renderPage(
    c,
    workspacePageDescriptor,
    () => [
      card({
        context: c,
        title: message("Discover workspace", { nl: "Werkplekken ontdekken" }),
        children: [
          table({
            context: c,
            model: "rent_reservations.Resource",
            where: (resource) => resource.active,
            columns: [
              "location",
              "name",
              "kind",
              "pooled",
              "capacity",
              "party_limit",
              "hourly",
              "daily",
              "price_unit",
              "amenities",
              "accessibility",
            ],
            filter: ["location", "kind", "pooled"],
            defaults: { location: c.preferences.rent_reservations.location },
            search: ["name"],
            display: "split",
            renderRow: (row, view) => [
              details({
                context: view,
                caption: policyTitle,
                children: [
                  text({
                    context: view,
                    values: [
                      row.timezone,
                      row.currency,
                      row.increment,
                      row.minimum,
                      row.terms,
                      row.refund_notice,
                    ],
                  }),
                ],
              }),
              ...[
                [
                  "hour",
                  "available",
                  "hold",
                  message("Check an hourly interval", { nl: "Een tijdvak per uur controleren" }),
                ],
                [
                  "day",
                  "available_days",
                  "hold_days",
                  message("Check local workspace days", { nl: "Lokale werkplekdagen controleren" }),
                ],
              ]
                .filter(([unit]) => row.price_unit === unit)
                .map(([unit, operation, hold, title]) =>
                  card({
                    context: view,
                    title,
                    children: [
                      form({
                        context: view,
                        operation: `rent_reservations.${operation}`,
                        arguments: { resource: row },
                        renderResult: (result, resultView) => [
                          text({
                            context: resultView,
                            values: [
                              result.available,
                              result.total,
                              result.terms,
                              ...(unit === "hour" ? [result.refund_before] : []),
                            ],
                          }),
                          ...(result.available
                            ? [
                                card({
                                  context: resultView,
                                  title: message("Hold this workspace", {
                                    nl: "Deze werkplek tijdelijk reserveren",
                                  }),
                                  children: [
                                    form({
                                      context: resultView,
                                      operation: `rent_reservations.${hold}`,
                                      arguments:
                                        unit === "hour"
                                          ? {
                                              resource: result.resource,
                                              from: result.from,
                                              until: result.until,
                                              quantity: result.quantity,
                                              attendees: result.attendees,
                                            }
                                          : {
                                              resource: result.resource,
                                              start: result.start,
                                              end: result.end,
                                              quantity: result.quantity,
                                              attendees: result.attendees,
                                            },
                                    }),
                                  ],
                                }),
                              ]
                            : []),
                        ],
                      }),
                    ],
                  }),
                ),
            ],
          }),
        ],
      }),
    ],
  );
}

export async function reservationsPage(c, bindings) {
  return renderPage(
    c,
    reservationsPageDescriptor,
    () => [
      card({
        context: c,
        title: message("Availability and booking evidence", {
          nl: "Beschikbaarheids- en reserveringsbewijs",
        }),
        children: [
          list({
            context: c,
            model: "rent_reservations.Resource",
            filter: ["location", "active"],
            defaults: { location: c.preferences.rent_reservations.location },
            display: "split",
            renderRow: (resource, view) => [
              edit({
                context: view,
                operation: "rent_reservations.Resource.update",
                record: resource,
              }),
              tabs({
                context: view,
                children: [
                  tab({
                    context: view,
                    caption: message("Resource windows", { nl: "Beschikbaarheidsvensters" }),
                    children: [
                      form({
                        context: view,
                        operation: "rent_reservations.DayCalendar.create",
                        arguments: { parent: resource },
                      }),
                      table({
                        context: view,
                        model: "rent_reservations.DayCalendar",
                        parent: resource,
                        columns: ["day", "opens", "closes", "closed"],
                        renderRow: (record, rowView) => [
                          edit({
                            context: rowView,
                            operation: "rent_reservations.DayCalendar.update",
                            record,
                          }),
                        ],
                      }),
                      form({
                        context: view,
                        operation: "rent_reservations.Window.create",
                        arguments: { parent: resource },
                      }),
                      table({
                        context: view,
                        model: "rent_reservations.Window",
                        parent: resource,
                        columns: ["from", "until", "closed", "reason"],
                        renderRow: (row, rowView) => [
                          edit({
                            context: rowView,
                            operation: "rent_reservations.Window.update",
                            record: row,
                          }),
                        ],
                      }),
                    ],
                  }),
                  tab({
                    context: view,
                    caption: message("Booking outcomes", { nl: "Reserveringsresultaten" }),
                    children: [
                      table({
                        context: view,
                        model: "rent_reservations.Booking",
                        parent: resource,
                        columns: [
                          "customer",
                          "from",
                          "until",
                          "quantity",
                          "status",
                          "payment",
                          "allowance",
                        ],
                        renderRow: (row, rowView) => [history({ context: rowView, record: row })],
                      }),
                    ],
                  }),
                  tab({
                    context: view,
                    caption: message("Capacity and desks", { nl: "Capaciteit en bureaus" }),
                    children: [
                      form({
                        context: view,
                        operation: "rent_reservations.revise_capacity",
                        arguments: { resource },
                      }),
                      table({
                        context: view,
                        model: "rent_reservations.CapacityRevision",
                        parent: resource,
                        columns: ["capacity", "effective", "reason"],
                      }),
                      form({
                        context: view,
                        operation: "rent_reservations.Desk.create",
                        arguments: { parent: resource },
                      }),
                      table({
                        context: view,
                        model: "rent_reservations.Desk",
                        parent: resource,
                        columns: ["name", "active"],
                        renderRow: (record, rowView) => [
                          edit({
                            context: rowView,
                            operation: "rent_reservations.Desk.update",
                            record,
                          }),
                        ],
                      }),
                      list({
                        context: view,
                        model: "rent_reservations.VenueReservation",
                        parent: resource,
                        renderRow: (row, rowView) => [
                          text({
                            context: rowView,
                            values: [row.source, row.from, row.until, row.quantity, row.status],
                          }),
                        ],
                      }),
                      list({
                        context: view,
                        model: "rent_reservations.QuoteHold",
                        parent: resource,
                        renderRow: (row, rowView) => [
                          text({
                            context: rowView,
                            values: [
                              row.source,
                              row.from,
                              row.until,
                              row.quantity,
                              row.expires,
                              row.active,
                            ],
                          }),
                        ],
                      }),
                      list({
                        context: view,
                        model: "rent_reservations.Conflict",
                        parent: resource,
                        where: (row) => !row.resolved,
                        renderRow: (row, rowView) => [
                          text({ context: rowView, values: [row.booking, row.reason] }),
                          action({
                            context: rowView,
                            operation: "rent_reservations.resolve_conflict",
                            boundArgs: { conflict: row },
                          }),
                        ],
                      }),
                    ],
                  }),
                  tab({
                    context: view,
                    caption: message("Repair blocks and restoration", {
                      nl: "Reparatieblokkades en herstel",
                    }),
                    children: [
                      form({
                        context: view,
                        operation: "rent_reservations.block",
                        arguments: { resource },
                      }),
                      list({
                        context: view,
                        model: "rent_reservations.Downtime",
                        parent: resource,
                        renderRow: (row, rowView) => [
                          text({
                            context: rowView,
                            values: [
                              row.from,
                              row.until,
                              row.reason,
                              row.active,
                              row.verified_by,
                              row.verification,
                            ],
                          }),
                          action({
                            context: rowView,
                            operation: "rent_reservations.restore",
                            boundArgs: { downtime: row },
                          }),
                        ],
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  );
}

export async function myBookingsPage(c, bindings) {
  return renderPage(
    c,
    myBookingsPageDescriptor,
    () => [
      card({
        context: c,
        title: message("Your booking outcomes", { nl: "Jouw reserveringsresultaten" }),
        children: [
          list({
            context: c,
            model: "rent_reservations.Booking",
            where: (booking) => same(booking.account, c.actor),
            order: ["from"],
            display: "split",
            renderRow: (booking, view) => [
              text({
                context: view,
                values: [
                  booking.from,
                  booking.until,
                  booking.total,
                  booking.status,
                  booking.payment,
                  booking.allowance,
                ],
              }),
              actions({
                context: view,
                operations: [
                  "rent_fulfillment.request",
                  "rent_reservations.fulfill_free",
                  "rent_reservations.reconcile_booking",
                  "rent_reservations.reconcile_allowance",
                  "rent_reservations.move",
                  "rent_reservations.move_days",
                  "rent_reservations.move_membership",
                  "rent_reservations.move_membership_days",
                  "rent_reservations.extend",
                  "rent_fulfillment.cancel",
                ],
                boundArgs: { booking },
              }),
              list({
                context: view,
                model: "rent_reservations.Movement",
                parent: booking,
                renderRow: (movement, rowView) => [
                  text({
                    context: rowView,
                    values: [movement.intervals, movement.state, movement.outcome],
                  }),
                  actions({
                    context: rowView,
                    operations: [
                      "rent_reservations.abandon_movement",
                      "rent_reservations.reconcile_movement",
                      "rent_reservations.retry_movement_cleanup",
                    ],
                    boundArgs: { movement },
                  }),
                ],
              }),
              list({
                context: view,
                model: "rent_reservations.Notice",
                parent: booking,
                renderRow: (notice, rowView) => [
                  text({ context: rowView, values: [notice.kind, notice.state, notice.subject] }),
                  action({
                    context: rowView,
                    operation: "rent_reservations.resend_notice",
                    boundArgs: { notice },
                  }),
                ],
              }),
              details({
                context: view,
                caption: message("Frozen commercial terms", {
                  nl: "Vastgelegde commerciële voorwaarden",
                }),
                children: [
                  text({
                    context: view,
                    values: [
                      booking.terms,
                      booking.refund_before,
                      booking.expires,
                      booking.checked_in,
                      booking.checked_out,
                      booking.cancellation_reason,
                    ],
                  }),
                ],
              }),
              history({ context: view, record: booking }),
            ],
          }),
        ],
      }),
    ],
  );
}

export async function arrivalsPage(c, bindings) {
  return renderPage(
    c,
    arrivalsPageDescriptor,
    () => [
      card({
        context: c,
        title: message("Physical arrivals and departures", {
          nl: "Werkelijke aankomsten en vertrekken",
        }),
        children: [
          table({
            context: c,
            model: "rent_reservations.Booking",
            columns: [
              "customer",
              "from",
              "until",
              "status",
              "checked_in",
              "checked_out",
              "overdue",
            ],
            filter: ["status"],
            display: "split",
            renderRow: (booking, view) => [
              actions({
                context: view,
                operations: [
                  "rent_fulfillment.request",
                  "rent_reservations.fulfill_free",
                  "rent_reservations.confirm_account",
                  "rent_fulfillment.check_in",
                  "rent_fulfillment.check_out",
                  "rent_reservations.no_show",
                  "rent_reservations.assign_desk",
                  "rent_fulfillment.cancel",
                ],
                boundArgs: { booking },
              }),
              history({ context: view, record: booking }),
            ],
          }),
        ],
      }),
    ],
  );
}

export async function financeReviewPage(c, bindings) {
  return renderPage(
    c,
    financeReviewPageDescriptor,
    () => [
      list({
        context: c,
        model: "rent_reservations.Booking",
        where: (booking) => ["review", "unknown", "pending"].includes(booking.refund_state),
        display: "split",
        renderRow: (booking, view) => [
          text({
            context: view,
            values: [
              booking.customer,
              booking.from,
              booking.until,
              booking.total,
              booking.status,
              booking.payment,
              booking.allowance,
              booking.refund_state,
            ],
          }),
          actions({
            context: view,
            operations: ["rent_reservations.reconcile_booking", "rent_reservations.refund_review"],
            boundArgs: { booking },
          }),
          history({ context: view, record: booking }),
        ],
      }),
      list({
        context: c,
        model: "rent_reservations.Booking",
        where: (booking) =>
          ["confirmed", "occupied", "completed", "no_show"].includes(booking.status),
        display: "split",
        renderRow: (booking, view) => [
          action({ context: view, operation: "rent_reservations.adjust", boundArgs: { booking } }),
          list({
            context: view,
            model: "rent_reservations.Movement",
            parent: booking,
            where: (row) => row.credit_due !== null && row.credit_due.minor > 0n,
            renderRow: (movement, rowView) => [
              text({ context: rowView, values: [movement.credit_due, movement.state] }),
              action({
                context: rowView,
                operation: "rent_reservations.refund_movement_credit",
                boundArgs: { movement },
              }),
              table({
                context: rowView,
                model: "rent_reservations.MovementCredit",
                parent: movement,
                columns: ["charge_source", "amount", "state", "reason"],
              }),
            ],
          }),
          list({
            context: view,
            model: "rent_reservations.Adjustment",
            parent: booking,
            renderRow: (adjustment, rowView) => [
              text({
                context: rowView,
                values: [
                  adjustment.amount,
                  adjustment.reason,
                  adjustment.state,
                  adjustment.new_until,
                ],
              }),
              action({
                context: rowView,
                operation: "rent_reservations.refund_adjustment",
                boundArgs: { adjustment },
              }),
            ],
          }),
        ],
      }),
    ],
  );
}

export async function occupancyPage(c, bindings) {
  const preferences = c.preferences.rent_reporting;
  return renderPage(
    c,
    occupancyPageDescriptor,
    () => [
      card({
        context: c,
        title: message("Booked agenda and physical occupancy", {
          nl: "Reserveringsagenda en werkelijke bezetting",
        }),
        children: [
          calendar({
            context: c,
            model: "rent_reservations.Booking",
            where: (booking) =>
              preferences.location === null || same(booking.parent.location, preferences.location),
            start: "from",
            end: "until",
            renderRow: (row, view) => [
              text({
                context: view,
                values: [row.quantity, row.status, row.checked_in, row.checked_out],
              }),
            ],
          }),
        ],
      }),
      card({
        context: c,
        title: message("Resource capacity", { nl: "Voorzieningscapaciteit" }),
        children: [
          table({
            context: c,
            model: "rent_reservations.Resource",
            columns: ["location", "name", "capacity"],
            filter: ["location"],
            defaults: { location: preferences.location },
            renderRow: (resource, view) =>
              hasRole(c, "rent_reservations.reservation_manager")
                ? [
                    card({
                      context: view,
                      title: message("Current source checkpoint", {
                        nl: "Huidig broncontrolepunt",
                      }),
                      children: [
                        form({
                          context: view,
                          operation: "rent_reservations.resource_report",
                          arguments: { resource },
                          renderResult: (result, resultView) => [
                            text({ context: resultView, values: [result.checkpoint] }),
                            table({
                              context: resultView,
                              rows: result.rows,
                              columns: [
                                "from",
                                "until",
                                "metric",
                                "quantity",
                                "unit",
                                "provisional",
                              ],
                            }),
                          ],
                        }),
                      ],
                    }),
                  ]
                : [],
          }),
        ],
      }),
    ],
  );
}

export async function bookingHistoryPage(c,bindings) {
  return renderPage(c,bookingHistoryPageDescriptor,()=>[
    hasRole(c,reservation_manager) ? card({context:c,title:message("Retain source bookings", {nl:"Bronreserveringen bewaren"}),children:[form({context:c,operation:"rent_reservations.retain_legacy",import:"csv",review:"rent_reservations.legacy_matches"})]}) : null,
    form({context:c,operation:"rent_reservations.legacy_matches",renderResult:(result,view)=>[list({context:view,rows:result,columns:["source","external_id","location"]})]}),
    table({context:c,model:LegacyBooking,archived:"include",columns:["source","external_id","location"],display:"split",renderRow:(entry,view)=>[
      text({context:view,values:[entry.facts.customer_source,entry.facts.customer_external_id,entry.facts.resource_source,entry.facts.resource_external_id,entry.facts.actor,entry.facts.from_original,entry.facts.until_original,entry.facts.from,entry.facts.until,entry.facts.status,entry.facts.payment,entry.facts.quantity,entry.facts.amount,entry.customer,entry.resource]}),
      (hasRole(view,reservation_manager)||hasRole(view,"invoice.finance")) ? card({context:view,title:message("Current mapping and source evidence", {nl:"Huidige koppeling en bronbewijs"}),children:[action({context:view,operation:"rent_reservations.link_legacy",boundArgs:{entry}}),text({context:view,values:[entry.account,entry.mapping_reason,entry.source_evidence,entry.attestation,entry.imported_by,entry.imported_at]}),history({context:view,record:entry})]}) : null,
    ]}),
  ]);
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
  { provider: "rent_catalog", member: "open_site", alias: "open_site" },
  { provider: "rent_catalog", member: "sunday_site", alias: "sunday_site" },
  { provider: "rent_catalog", member: "recorded_site", alias: "recorded_site" },
  { provider: "employee", member: "test_worker", alias: "test_worker" },
  { provider: "customer", member: "test_company", alias: "test_company" },
  { provider: "customer", member: "test_admin", alias: "test_admin" },
  { provider:"customer",member:"test_booker",alias:"test_booker" },
];

export function exampleFixtures({ self, other, imported }) {
  const {
    test_site,
    open_site,
    sunday_site,
    recorded_site,
    test_worker,
    test_company,
    test_admin,
    test_booker,
  } = imported;
  const test_room = {
    model: "rent_reservations.Resource",
    dependencies: [test_site],
    value: async (c, s) => ({
      location: s.test_site,
      name: "Room",
      timezone: "Europe/Brussels",
      currency: "EUR",
      hourly: money(1000n, "EUR"),
      terms: "Full balance before admission",
      refund_notice: 86400000n,
      accessibility: "Step-free",
    }),
  };
  const test_window = {
    model: "rent_reservations.Window",
    dependencies: [test_room],
    value: async (c, s) => ({
      parent: s.test_room,
      from: datetime("2026-10-01T00:00:00Z"),
      until: datetime("2026-11-01T00:00:00Z"),
    }),
  };
  const test_hold = {
    model: "rent_reservations.Booking",
    dependencies: [test_company, test_room],
    value: async (c, s) => ({
      parent: s.test_room,
      customer: s.test_company,
      account: s.self,
      email: "customer@example.test",
      from: datetime("2026-10-04T09:00:00Z"),
      until: datetime("2026-10-04T10:00:00Z"),
      rate: money(1000n, "EUR"),
      subtotal: money(1000n, "EUR"),
      tax: money(0n, "EUR"),
      discount: money(0n, "EUR"),
      refund_amount: money(1000n, "EUR"),
      total: money(1000n, "EUR"),
      terms: "Full balance before admission",
      refund_before: datetime("2026-10-03T09:00:00Z"),
      reserved_from: datetime("2026-10-04T09:00:00Z"),
      reserved_until: datetime("2026-10-04T10:00:00Z"),
      expires: datetime("2026-10-03T12:15:00Z"),
      source: "test-hold",
    }),
  };
  const recorded_resource = {
    model: "rent_reservations.ResourcePolicy",
    dependencies: [test_room],
    value: async (c, s) => ({
      parent: s.test_room,
      effective: subtractDuration(c.now, 172800000n),
      sequence: 1n,
      value: {
        active: true,
        capacity: 1n,
        pooled: false,
        timezone: "Europe/Brussels",
        windows: [
          {
            from: subtractDuration(c.now, 172800000n),
            until: addDuration(c.now, 172800000n),
            closed: false,
          },
        ],
        downtime: [],
        bookings: [],
        venues: [],
      },
    }),
  };
  const test_sale = {
    model: "rent_reservations.CommercialSale",
    dependencies: [test_hold],
    value: async (c, s) => ({ parent: s.test_hold }),
  };
  const history_user={dependencies:[],user:async(c,s)=>({roles:[reservation_manager,"invoice.finance"]})};
  const history_worker={model:"employee.Employee",dependencies:[history_user,test_site],value:async(c,s)=>({user:s.history_user,home:s.test_site,locations:[s.test_site],start:date("2026-10-01"),role:"Historical evidence steward"})};
  const legacy_source={dependencies:[history_user],file:async(c,s)=>({owner:s.history_user})};
  const legacy_booking={model:LegacyBooking,dependencies:[test_site,legacy_source],value:async(c,s)=>({source:"vendor-w",external_id:"B-17",location:s.test_site,facts:{customer_source:"vendor-w",customer_external_id:"C-9",resource_source:"vendor-w",resource_external_id:"R-2",actor:"Former booker",from_original:"2021-05-12 09:00",until_original:"2021-05-12 10:00",status:"Completed",payment:"Paid",amount:money(1000n,"EUR")},source_evidence:s.legacy_source,attestation:"Original export retained; local-time offset unknown"})};
  const quote_window = {model:"rent_reservations.Window",dependencies:[test_room],value:async(c,s)=>({parent:s.test_room,from:datetime("2099-01-01T08:00:00Z"),until:datetime("2099-01-01T18:00:00Z")})};
  const quote_day = {model:"rent_reservations.DayCalendar",dependencies:[test_room],value:async(c,s)=>({parent:s.test_room,day:date("2099-01-01")})};
  const quoted_hold = {model:"rent_reservations.QuoteHold",dependencies:[test_room,test_company,test_site],value:async(c,s)=>({
    parent:s.test_room,source:"quote-test",revision:1n,quantity:1n,from:datetime("2099-01-01T09:00:00Z"),until:datetime("2099-01-01T10:00:00Z"),intervals:[],expires:datetime("2099-01-01T08:00:00Z"),
    offer:{source:"quote-test",revision:1n,customer:s.test_company.id,location:s.test_site.id,resource:s.test_room.id,recipient:"customer@example.test",quantity:1n,attendees:1n,hold_until:datetime("2099-01-01T08:00:00Z"),
      snapshot:{issuer:"Operator",customer:"Example company",resource:s.test_room.id,quantity:1n,attendees:1n,recipient:"customer@example.test",title:"Frozen room offer",location:"Main",from:datetime("2099-01-01T09:00:00Z"),until:datetime("2099-01-01T10:00:00Z"),intervals:[],terms:"Frozen terms",refund_before:datetime("2099-01-01T09:00:00Z"),expires:datetime("2099-01-01T08:00:00Z"),lines:[{title:"Room",quantity:"1",unit:"hour",price:money(1000n,"EUR"),tax:money(0n,"EUR"),discount:money(0n,"EUR")}],total:money(1000n,"EUR")}}
  })};
  const acceptedQuote = (c,s)=>({product:null,attribution:null,exclusive_program:null,attributed_at:null,attribution_window:null,source:"quote-test",revision:1n,customer:s.test_company.id,location:s.test_site.id,resource:s.test_room.id,account:s.self,recipient:"customer@example.test",accepted_at:c.now,quantity:1n,attendees:1n,snapshot:s.quoted_hold.offer.snapshot});
  const closed_quote = {model:"rent_reservations.ReservationFence",dependencies:[quoted_hold],value:async(c,s)=>({parent:s.test_room,source:"quote-test",revision:1n,reason:"Quoted inventory unavailable",offer:acceptedQuote(c,s)})};
  return {
    quote_window,quote_day,quoted_hold,closed_quote,
    history_user,history_worker,legacy_source,legacy_booking,
    test_sale,
    test_hold,
    test_room,
    test_window,
    recorded_resource,
    examples: [
      {operation:"rent_reservations.move",seed:[history_worker,open_site,quote_window],dependencies:[history_worker,open_site,quote_window,test_hold],inputs:async(c,s)=>({booking:s.test_hold,from:datetime("2099-01-01T11:00:00Z"),until:datetime("2099-01-01T12:00:00Z")}),selectors:["as","booking.account","history_worker.active"],observations:[async(c,s)=>s.test_hold.from],rows:[
        {dependencies:[],values:async(c,s)=>[s.history_user,s.history_user,true],expected:async(c,s)=>[datetime("2099-01-01T11:00:00Z")]},
        {dependencies:[],values:async(c,s)=>[s.history_user,s.history_user,false],error:"rule_failed"},
      ]},
      {operation:"rent_reservations.quote_accept",seed:[test_admin,closed_quote,test_hold],dependencies:[test_admin,closed_quote,test_hold],inputs:async(c,s)=>({event:{value:acceptedQuote(c,s)}}),selectors:["test_hold.source","test_hold.status"],observations:[async(c,s)=>await count(records(c,Booking,{parent:s.test_room}))],rows:[
        {dependencies:[],values:async(c,s)=>["quote-test","confirmed"],error:"rule_failed"},
      ]},
      {operation:"rent_reservations.quote_release",seed:[test_hold],dependencies:[test_hold,test_room],inputs:async(c,s)=>({event:{source:s.test_hold.source,revision:1n,resource:s.test_room.id,reason:"Close quoted inventory"}}),selectors:["test_hold.status","test_hold.payment"],observations:[async(c,s)=>s.test_hold.status,async(c,s)=>s.test_hold.payment,async(c,s)=>await count(records(c,Booking,{parent:s.test_room})),async(c,s)=>await count(records(c,"rent_reservations.ReservationFence",{parent:s.test_room}))],rows:[
        {dependencies:[],values:async(c,s)=>["confirmed","paid"],expected:async(c,s)=>["confirmed","paid",1n,1n]},
        {dependencies:[],values:async(c,s)=>["cancelled","refunded"],expected:async(c,s)=>["cancelled","refunded",1n,1n]},
      ]},
      {operation:"rent_reservations.quote_accept",seed:[test_admin,open_site,quote_window,quoted_hold],dependencies:[test_admin,open_site,quote_window,quoted_hold],inputs:async(c,s)=>({event:{value:acceptedQuote(c,s)}}),selectors:["test_admin.active","test_admin.locations","test_company.active","test_room.active"],observations:[async(c,s)=>await count(records(c,Booking,{parent:s.test_room})),async(c,s)=>await count(records(c,"rent_reservations.ReservationFence",{parent:s.test_room})),async(c,s)=>s.quoted_hold.active],rows:[
        {dependencies:[],values:async(c,s)=>[true,[s.test_site],true,true],expected:async(c,s)=>[1n,0n,false]},
        {dependencies:[],values:async(c,s)=>[false,[s.test_site],true,true],error:"rule_failed"},
        {dependencies:[],values:async(c,s)=>[true,[],true,true],error:"rule_failed"},
        {dependencies:[],values:async(c,s)=>[true,[s.test_site],false,true],error:"rule_failed"},
        {dependencies:[],values:async(c,s)=>[true,[s.test_site],true,false],expected:async(c,s)=>[0n,1n,false]},
      ]},
      {operation:"rent_reservations.quote_accept",seed:[test_admin,closed_quote],dependencies:[test_admin,closed_quote],inputs:async(c,s)=>({event:{value:acceptedQuote(c,s)}}),selectors:["closed_quote.offer","quoted_hold.active","event.value.snapshot.terms"],observations:[async(c,s)=>await count(records(c,Booking,{parent:s.test_room})),async(c,s)=>s.closed_quote.version,async(c,s)=>s.quoted_hold.active],rows:[
        {dependencies:[],values:async(c,s)=>[s.closed_quote.offer,false,"Frozen terms"],expected:async(c,s)=>[0n,1n,false]},
        {dependencies:[],values:async(c,s)=>[s.closed_quote.offer,false,"Changed terms"],error:"rule_failed"},
        {dependencies:[],values:async(c,s)=>[null,false,"Frozen terms"],expected:async(c,s)=>[0n,1n,false]},
      ]},
      {operation:"rent_reservations.move",seed:[test_admin,open_site,quote_window],dependencies:[test_admin,open_site,quote_window,test_hold],inputs:async(c,s)=>({booking:s.test_hold,from:datetime("2099-01-01T11:00:00Z"),until:datetime("2099-01-01T12:00:00Z")}),selectors:["as","test_admin.active","test_admin.locations","test_company.active"],observations:[async(c,s)=>s.test_hold.from],rows:[
        {dependencies:[],values:async(c,s)=>[s.self,true,[s.test_site],true],expected:async(c,s)=>[datetime("2099-01-01T11:00:00Z")]},
        {dependencies:[],values:async(c,s)=>[s.self,false,[s.test_site],true],error:"rule_failed"},
        {dependencies:[],values:async(c,s)=>[s.self,true,[],true],error:"rule_failed"},
        {dependencies:[],values:async(c,s)=>[s.self,true,[s.test_site],false],error:"rule_failed"},
      ]},
      {operation:"rent_reservations.move_days",seed:[test_admin,open_site,quote_window,quote_day],dependencies:[test_admin,open_site,quote_window,quote_day,test_hold],inputs:async(c,s)=>({booking:s.test_hold,start:date("2099-01-01"),end:date("2099-01-02")}),selectors:["as","test_admin.active","test_admin.locations","booking.intervals"],observations:[async(c,s)=>s.test_hold.from],rows:[
        {dependencies:[],values:async(c,s)=>[s.self,true,[s.test_site],[{from:s.test_hold.from,until:s.test_hold.until}]],expected:async(c,s)=>[datetime("2099-01-01T08:00:00Z")]},
        {dependencies:[],values:async(c,s)=>[s.self,false,[s.test_site],[{from:s.test_hold.from,until:s.test_hold.until}]],error:"rule_failed"},
        {dependencies:[],values:async(c,s)=>[s.self,true,[],[{from:s.test_hold.from,until:s.test_hold.until}]],error:"rule_failed"},
      ]},
      {operation:"rent_reservations.retain_legacy",seed:[history_worker,legacy_booking],dependencies:[history_worker,legacy_booking,test_site,legacy_source],inputs:async(c,s)=>({source:"vendor-w",external_id:" B-18 ",location:s.test_site,facts:{customer_source:"vendor-w",customer_external_id:"C-9",from_original:"2021-05-12 09:00",status:"Unknown",amount:null},source_evidence:s.legacy_source,attestation:"Checked source export"}),selectors:["as","external_id","history_worker.active"],observations:[async(c,s)=>s.result.external_id,async(c,s)=>s.result.facts.from,async(c,s)=>s.result.facts.amount,async(c,s)=>s.result.account,async(c,s)=>s.result.imported_by,async(c,s)=>await count(records(c,Booking))],rows:[
        {dependencies:[],values:async(c,s)=>[s.history_user," B-18 ",true],expected:async(c,s)=>[" B-18 ",null,null,null,s.history_user,0n]},
        {dependencies:[],values:async(c,s)=>[s.history_user,"B-17",true],error:"rule_failed"},
        {dependencies:[],values:async(c,s)=>[s.history_user,"B-18",false],error:"rule_failed"},
        {dependencies:[],values:async(c,s)=>["members","B-18",true],error:"forbidden"},
      ]},
      {operation:"rent_reservations.legacy_matches",seed:[history_worker,legacy_booking],dependencies:[history_worker,legacy_booking,test_site],inputs:async(c,s)=>({source:"vendor-w",external_id:"B-17",location:s.test_site}),selectors:["as"],observations:[async(c,s)=>await count(s.result)],rows:[
        {dependencies:[],values:async(c,s)=>[s.history_user],expected:async(c,s)=>[1n]},
        {dependencies:[],values:async(c,s)=>["members"],expected:async(c,s)=>[0n]},
        {dependencies:[],values:async(c,s)=>["public"],error:"forbidden"},
      ]},
      {operation:"rent_reservations.link_legacy",seed:[history_worker,test_booker],dependencies:[history_worker,test_booker,legacy_booking,test_company,test_room],inputs:async(c,s)=>({entry:s.legacy_booking,customer:s.test_company,resource:s.test_room,account:s.other,reason:"Reviewed original customer/resource keys against existing records"}),selectors:["as","customer","resource","account","reason","request.entry.version"],observations:[async(c,s)=>s.legacy_booking.customer,async(c,s)=>s.legacy_booking.resource,async(c,s)=>s.legacy_booking.account,async(c,s)=>s.legacy_booking.facts.customer_external_id,async(c,s)=>s.legacy_booking.mapping_reason],rows:[
        {dependencies:[],values:async(c,s)=>[s.history_user,s.test_company,s.test_room,s.other,"Verified source keys",1n],expected:async(c,s)=>[s.test_company,s.test_room,s.other,"C-9","Verified source keys"]},
        {dependencies:[],values:async(c,s)=>[s.history_user,null,null,null,"Revoke mistaken mapping",1n],expected:async(c,s)=>[null,null,null,"C-9","Revoke mistaken mapping"]},
        {dependencies:[],values:async(c,s)=>[s.history_user,s.test_company,s.test_room,s.self,"Unverified account",1n],error:"rule_failed"},
        {dependencies:[],values:async(c,s)=>[s.history_user,s.test_company,s.test_room,s.other," ",1n],error:"rule_failed"},
        {dependencies:[],values:async(c,s)=>[s.history_user,s.test_company,s.test_room,s.other,"Verified source keys",2n],error:"conflict"},
        {dependencies:[],values:async(c,s)=>["members",s.test_company,s.test_room,s.other,"Verified source keys",1n],error:"forbidden"},
      ]},
      {
        operation: "rent_reservations.commercial_check",
        seed: [test_sale],
        dependencies: [test_sale],
        inputs: async (c, s) => ({ event: { booking: s.test_hold } }),
        selectors: [
          "test_hold.billing_location",
          "test_hold.sale_product",
          "test_hold.purchased_at",
          "test_hold.monetary_due",
          "test_hold.billing_delivery",
          "test_hold.collected",
          "test_hold.refunded",
          "test_hold.status",
          "test_hold.payment",
          "test_hold.checked_out",
          "test_sale.phase",
        ],
        observations: [async (c, s) => s.test_sale.phase, async (c, s) => s.test_sale.revision],
        rows: [
          {
            dependencies: [test_site],
            values: async (c, s) => [
              s.test_site,
              "meeting",
              subtractDuration(c.now, 3600000n),
              money(500n, "EUR"),
              "original-charge",
              money(500n, "EUR"),
              money(0n, "EUR"),
              "confirmed",
              "paid",
              null,
              null,
            ],
            expected: async (c, s) => ["paid", 1n],
          },
          {
            dependencies: [test_site],
            values: async (c, s) => [
              s.test_site,
              "meeting",
              subtractDuration(c.now, 3600000n),
              money(500n, "EUR"),
              "original-charge",
              money(500n, "EUR"),
              money(0n, "EUR"),
              "completed",
              "paid",
              c.now,
              null,
            ],
            expected: async (c, s) => ["completed", 1n],
          },
          {
            dependencies: [test_site],
            values: async (c, s) => [
              s.test_site,
              "meeting",
              subtractDuration(c.now, 3600000n),
              money(500n, "EUR"),
              "original-charge",
              money(500n, "EUR"),
              money(0n, "EUR"),
              "cancelled",
              "paid",
              null,
              "paid",
            ],
            expected: async (c, s) => ["reversed", 1n],
          },
          {
            dependencies: [test_site],
            values: async (c, s) => [
              s.test_site,
              "meeting",
              subtractDuration(c.now, 3600000n),
              money(500n, "EUR"),
              "original-charge",
              money(500n, "EUR"),
              money(0n, "EUR"),
              "expired",
              "paid",
              null,
              null,
            ],
            expected: async (c, s) => [null, 0n],
          },
          {
            dependencies: [test_site],
            values: async (c, s) => [
              s.test_site,
              "meeting",
              subtractDuration(c.now, 3600000n),
              money(500n, "EUR"),
              "original-charge",
              money(500n, "EUR"),
              money(0n, "EUR"),
              "confirmed",
              "paid",
              null,
              "reversed",
            ],
            expected: async (c, s) => ["reversed", 0n],
          },
          {
            dependencies: [test_site],
            values: async (c, s) => [
              s.test_site,
              "meeting",
              subtractDuration(c.now, 3600000n),
              money(0n, "EUR"),
              "original-charge",
              money(0n, "EUR"),
              money(0n, "EUR"),
              "confirmed",
              "free",
              null,
              null,
            ],
            expected: async (c, s) => [null, 0n],
          },
        ],
      },
      {
        operation: "rent_reservations.resource_report",
        seed: [recorded_resource, recorded_site],
        dependencies: [test_room],
        inputs: async (c, s) => ({
          resource: s.test_room,
          from: local_instant(local_date(c.now, "Europe/Brussels"), "09:00", "Europe/Brussels", {
            fold: "earlier",
          }),
          until: local_instant(local_date(c.now, "Europe/Brussels"), "10:00", "Europe/Brussels", {
            fold: "earlier",
          }),
        }),
        selectors: ["test_room.active"],
        observations: [
          async (c, s) => s.result.checkpoint.complete,
          async (c, s) =>
            sum(
              s.result.rows.filter((item) => item.metric === "saleable_minutes"),
              (item) => item.quantity,
            ),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => [true],
            expected: async (c, s) => [true, "60"],
          },
          {
            dependencies: [],
            values: async (c, s) => [false],
            expected: async (c, s) => [true, "60"],
          },
        ],
      },
      {
        operation: "rent_reservations.resource_report",
        seed: [recorded_resource, recorded_site],
        dependencies: [test_room],
        inputs: async (c, s) => ({ resource: s.test_room }),
        selectors: ["from", "until"],
        observations: [
          async (c, s) => s.result.checkpoint.complete,
          async (c, s) => count(s.result.rows),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => [
              subtractDuration(c.now, 864000000n),
              addDuration(subtractDuration(c.now, 864000000n), 3600000n),
            ],
            expected: async (c, s) => [false, 0n],
          },
        ],
      },
      {
        operation: "rent_reservations.available",
        seed: [test_hold, test_window, sunday_site],
        dependencies: [test_room],
        inputs: async (c, s) => ({
          resource: s.test_room,
          from: local_instant(
            add_days(local_date(c.now, "Europe/Brussels"), 1n),
            "10:00",
            "Europe/Brussels",
            { fold: "earlier" },
          ),
          until: local_instant(
            add_days(local_date(c.now, "Europe/Brussels"), 1n),
            "11:00",
            "Europe/Brussels",
            { fold: "earlier" },
          ),
        }),
        selectors: [
          "test_hold.from",
          "test_hold.until",
          "test_hold.reserved_from",
          "test_hold.reserved_until",
          "test_hold.expires",
          "test_window.from",
          "test_window.until",
          "sunday_site.weekday",
          "test_hold.status",
          "test_hold.checked_in",
        ],
        observations: [async (c, s) => s.result.available],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => {
              const from = local_instant(
                  add_days(local_date(c.now, "Europe/Brussels"), 1n),
                  "10:00",
                  "Europe/Brussels",
                  { fold: "earlier" },
                ),
                until = local_instant(
                  add_days(local_date(c.now, "Europe/Brussels"), 1n),
                  "11:00",
                  "Europe/Brussels",
                  { fold: "earlier" },
                );
              return [
                from,
                until,
                from,
                until,
                subtractDuration(c.now, 60000n),
                subtractDuration(c.now, 86400000n),
                addDuration(c.now, 259200000n),
                weekday(local_date(from, "Europe/Brussels")),
                "held",
                null,
              ];
            },
            expected: async (c, s) => [true],
          },
          {
            dependencies: [],
            values: async (c, s) => {
              const from = local_instant(
                  add_days(local_date(c.now, "Europe/Brussels"), 1n),
                  "10:00",
                  "Europe/Brussels",
                  { fold: "earlier" },
                ),
                until = local_instant(
                  add_days(local_date(c.now, "Europe/Brussels"), 1n),
                  "11:00",
                  "Europe/Brussels",
                  { fold: "earlier" },
                );
              return [
                from,
                until,
                from,
                until,
                subtractDuration(c.now, 60000n),
                subtractDuration(c.now, 86400000n),
                addDuration(c.now, 259200000n),
                weekday(local_date(from, "Europe/Brussels")),
                "pending",
                null,
              ];
            },
            expected: async (c, s) => [true],
          },
          {
            dependencies: [],
            values: async (c, s) => {
              const from = local_instant(
                  add_days(local_date(c.now, "Europe/Brussels"), 1n),
                  "10:00",
                  "Europe/Brussels",
                  { fold: "earlier" },
                ),
                until = local_instant(
                  add_days(local_date(c.now, "Europe/Brussels"), 1n),
                  "11:00",
                  "Europe/Brussels",
                  { fold: "earlier" },
                );
              return [
                from,
                until,
                from,
                until,
                subtractDuration(c.now, 60000n),
                subtractDuration(c.now, 86400000n),
                addDuration(c.now, 259200000n),
                weekday(local_date(from, "Europe/Brussels")),
                "confirmed",
                null,
              ];
            },
            expected: async (c, s) => [false],
          },
          {
            dependencies: [],
            values: async (c, s) => {
              const from = local_instant(
                  add_days(local_date(c.now, "Europe/Brussels"), 1n),
                  "10:00",
                  "Europe/Brussels",
                  { fold: "earlier" },
                ),
                until = local_instant(
                  add_days(local_date(c.now, "Europe/Brussels"), 1n),
                  "11:00",
                  "Europe/Brussels",
                  { fold: "earlier" },
                );
              return [
                from,
                until,
                from,
                until,
                subtractDuration(c.now, 60000n),
                subtractDuration(c.now, 86400000n),
                addDuration(c.now, 259200000n),
                weekday(local_date(from, "Europe/Brussels")),
                "cancelled",
                c.now,
              ];
            },
            expected: async (c, s) => [false],
          },
        ],
      },
      {
        operation: "rent_reservations.money",
        seed: [test_hold, test_window, sunday_site],
        dependencies: [],
        inputs: async (c, s) => ({
          event: {
            value: {
              source: "test-hold",
              invoice: "invoice-test",
              revision: 1n,
              amount: money(1000n, "EUR"),
              collected: money(1000n, "EUR"),
              refunded: money(0n, "EUR"),
              collection_pending: false,
              refund_pending: false,
              state: "issued",
              recorded_at: c.now,
            },
          },
        }),
        selectors: [
          "test_hold.from",
          "test_hold.until",
          "test_hold.reserved_from",
          "test_hold.reserved_until",
          "test_hold.expires",
          "test_window.from",
          "test_window.until",
          "sunday_site.weekday",
          "test_hold.status",
          "test_hold.cancel_delivery",
          "event.value.state",
        ],
        observations: [
          async (c, s) => s.test_hold.status,
          async (c, s) => s.test_hold.refund_state,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => {
              const from = local_instant(
                  add_days(local_date(c.now, "Europe/Brussels"), 1n),
                  "10:00",
                  "Europe/Brussels",
                  { fold: "earlier" },
                ),
                until = local_instant(
                  add_days(local_date(c.now, "Europe/Brussels"), 1n),
                  "11:00",
                  "Europe/Brussels",
                  { fold: "earlier" },
                );
              return [
                from,
                until,
                from,
                until,
                subtractDuration(c.now, 60000n),
                subtractDuration(c.now, 86400000n),
                addDuration(c.now, 259200000n),
                weekday(local_date(from, "Europe/Brussels")),
                "expired",
                null,
                "issued",
              ];
            },
            expected: async (c, s) => ["confirmed", "none"],
          },
          {
            dependencies: [],
            values: async (c, s) => {
              const from = local_instant(
                  add_days(local_date(c.now, "Europe/Brussels"), 1n),
                  "10:00",
                  "Europe/Brussels",
                  { fold: "earlier" },
                ),
                until = local_instant(
                  add_days(local_date(c.now, "Europe/Brussels"), 1n),
                  "11:00",
                  "Europe/Brussels",
                  { fold: "earlier" },
                );
              return [
                from,
                until,
                from,
                until,
                subtractDuration(c.now, 60000n),
                subtractDuration(c.now, 86400000n),
                addDuration(c.now, 259200000n),
                weekday(local_date(from, "Europe/Brussels")),
                "expired",
                "cancel-accepted",
                "issued",
              ];
            },
            expected: async (c, s) => ["review", "review"],
          },
          {
            dependencies: [],
            values: async (c, s) => {
              const from = local_instant(
                  add_days(local_date(c.now, "Europe/Brussels"), 1n),
                  "10:00",
                  "Europe/Brussels",
                  { fold: "earlier" },
                ),
                until = local_instant(
                  add_days(local_date(c.now, "Europe/Brussels"), 1n),
                  "11:00",
                  "Europe/Brussels",
                  { fold: "earlier" },
                );
              return [
                from,
                until,
                from,
                until,
                subtractDuration(c.now, 60000n),
                subtractDuration(c.now, 86400000n),
                addDuration(c.now, 259200000n),
                weekday(local_date(from, "Europe/Brussels")),
                "expired",
                null,
                "void_pending",
              ];
            },
            expected: async (c, s) => ["review", "review"],
          },
        ],
      },
      {
        operation: "rent_reservations.hold",
        seed: [sunday_site, test_admin, test_window],
        dependencies: [test_company, test_room],
        inputs: async (c, s) => ({
          resource: s.test_room,
          customer: s.test_company,
          from: datetime("2026-10-04T09:00:00Z"),
          until: datetime("2026-10-04T10:00:00Z"),
          email: "customer@example.test",
        }),
        selectors: ["quantity"],
        observations: [async (c, s) => s.result.status],
        rows: [
          { dependencies: [], values: async (c, s) => [2n], error: "rule_failed" },
          { dependencies: [], values: async (c, s) => [0n], error: "rule_failed" },
        ],
      },
      {
        operation: "rent_reservations.venue_release",
        seed: [test_room],
        dependencies: [test_room],
        inputs: async (c, s) => ({
          event: {
            source: "released-before-arrival",
            resource: s.test_room.id,
            reason: "Abandoned candidate",
          },
        }),
        selectors: ["event.source"],
        observations: [
          async (c, s) =>
            await count(records(c, "rent_reservations.VenueFence", { parent: s.test_room })),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["released-before-arrival"],
            expected: async (c, s) => [1n],
          },
        ],
      },
      {
        operation: "rent_reservations.money",
        seed: [test_hold],
        dependencies: [],
        inputs: async (c, s) => ({
          event: {
            value: {
              source: "test-hold",
              invoice: "invoice-test",
              revision: 1n,
              amount: money(1000n, "EUR"),
              collected: money(1000n, "EUR"),
              refunded: money(0n, "EUR"),
              collection_pending: false,
              refund_pending: false,
              state: "issued",
              recorded_at: datetime("2026-10-04T10:00:00Z"),
            },
          },
        }),
        selectors: ["test_hold.status"],
        observations: [async (c, s) => s.test_hold.status, async (c, s) => s.test_hold.payment],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["cancelled"],
            expected: async (c, s) => ["cancelled", "paid"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["expired"],
            expected: async (c, s) => ["review", "paid"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["completed"],
            expected: async (c, s) => ["completed", "paid"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["no_show"],
            expected: async (c, s) => ["no_show", "paid"],
          },
        ],
      },
      {
        operation: "rent_reservations.money",
        seed: [test_hold],
        dependencies: [],
        inputs: async (c, s) => ({
          event: {
            value: {
              source: "test-hold",
              invoice: "invoice-test",
              revision: 1n,
              amount: money(1000n, "EUR"),
              collected: money(0n, "EUR"),
              refunded: money(0n, "EUR"),
              collection_pending: true,
              refund_pending: false,
              state: "issued",
              recorded_at: datetime("2026-10-04T10:00:00Z"),
            },
          },
        }),
        selectors: ["test_hold.settlement_revision", "test_hold.payment"],
        observations: [async (c, s) => s.test_hold.payment],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => [2n, "paid"],
            expected: async (c, s) => ["paid"],
          },
        ],
      },
      {
        operation: "rent_reservations.consumption",
        seed: [test_hold],
        dependencies: [],
        inputs: async (c, s) => ({
          event: {
            delivery_id: "consume-test",
            status: "failed",
            result: null,
            error: { code: "rejected", message: "Owner rejected consumption" },
          },
        }),
        selectors: ["test_hold.status", "test_hold.consume_delivery"],
        observations: [async (c, s) => s.test_hold.status],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["cancelled", "consume-test"],
            expected: async (c, s) => ["cancelled"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["completed", "consume-test"],
            expected: async (c, s) => ["completed"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["pending", "consume-test"],
            expected: async (c, s) => ["review"],
          },
        ],
      },
    ],
  };
}
