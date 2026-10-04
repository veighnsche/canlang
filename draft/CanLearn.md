# CanLearn requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanLearn.can](CanLearn.can).

## Purpose and Adoption Goal

Help workspace operators deliver text-based staff induction, safety procedures, and member orientation. Adoption depends on each person finding the correct published training and managers seeing attributable completion.

## Users and Permissions

Instructors manage course content and enrollments. Authenticated learners read lesson content only in their active, currently eligible published enrollment and record only their own completions. Withdrawn learners retain their own version metadata and completion evidence. Team membership is not a substitute for learner access.

## Data and Ownership

Courses have a title; lessons have title, text content, and ordered position. Course publication creates a version with an ordered lesson set. Enrollment links a user to that version and active/withdrawn status. Completion is unique by enrollment and lesson and records its actor/time; zero-lesson progress is zero.

Record course audience, applicable locations, required/optional status, enrollment due date, and completion version. Member learners and staff learners are distinct authorized audiences; customer membership alone cannot expose internal operating procedures.

## Workflows and Business Rules

Learners mark a lesson complete only within their enrolled version. Publication freezes the lesson set for existing enrollments, so later edits/new lessons do not silently change their progress. Withdrawal revokes lesson access while preserving authorized completion history.

Assign required training manually or through an explicitly configured enrollment capability. A new mandatory procedure version creates a new enrollment requirement without erasing completion of the old version. Text-lesson completion records an acknowledgment, not proof of examination or certification.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Order navigation as My learning, then Course authoring for instructors. Enrolled course and lesson details are contextual links. Staff and member learners share presentation but retain distinct course audiences; team membership or a customer membership never reveals internal procedures.

| Page or destination | daisyUI layout and content | Canonical actions and conditions |
| --- | --- | --- |
| My learning — authenticated own index | Required/optional and overdue Tabs, permitted location/audience Select filters, enrollment Cards with due date, version and progress Stat | Open only actively enrolled published versions and record own completion through the owning operation |
| Course lessons — contextual enrolled view | Ordered lesson List with readable text content, current lesson heading and completion Badge; clear previous/next Buttons | Acknowledge the exact lesson/enrollment pair; withdrawal removes lesson access while preserving authorized history |
| Course authoring — instructor index | Course Table with audience/location/required filters; course and ordered draft-lesson Fieldsets | Create/edit course and unpublished drafts, arrange lesson positions and publish a frozen version under instructor authority |
| Version progress — contextual instructor view | Enrollment Table for the selected published version, due dates, active state and attributable completion; export Button | Enroll/withdraw eligible users and export only the selected version's authorized completion records |

Keep lesson reading and the completion control accessible in one column on phones; long text must not hide the next permitted action. Show loading, no assigned courses, overdue-empty and no filter matches distinctly. Preserve unsaved draft text during invalid submission or language/theme changes. Refresh stale enrollment or version state and explain why a completion is unavailable without increasing progress. Duplicate acknowledgments show their saved outcome, not added progress. A zero-lesson enrollment clearly displays zero; a new published version never changes an existing enrollment's denominator. Instructor progress exports are scoped to the selected version and disclose no unrelated HR documents. Learning/authoring needs no added administration console.

## Personal Configuration

Inherit shared account/language/appearance persistence, validation and reset. Learners may remember required/optional or overdue filters and their preferred course-list order; instructors may remember permitted audience/location filters. Provide clear/reset and revalidate saved filter access. Preferences do not enroll a person, select a different authoritative course version, mark lessons complete or expose drafts. Reading preferences cannot rewrite enrolled content or certify learners.

## Interfaces and Integrations

Use D1 for course, enrollment, and completion records.

## Background Actions

None in the first version.

## Error Handling

Explain duplicate completions and lesson/course mismatches. Reject invalid completion records without increasing progress.

## Scope and Completion

Complete when a learner can actually access and complete an enrolled course, another learner cannot alter that progress, and content revision does not rewrite an old enrollment's denominator. Initial lessons are text content.

A new receptionist can acknowledge the published opening procedures, and a member can complete their own site orientation without reading staff-only lessons.

Frontend journey: a member learner opens their enrolled orientation, reads ordered text and acknowledges a lesson; duplicate submission shows the prior result, while staff-only courses stay absent from navigation and direct access.

Frontend journey: an instructor publishes a revised procedure and exports progress for the earlier version. Existing learners retain that version's lesson denominator; withdrawing an enrollment removes its lesson actions and explains the unavailable state without erasing history.

## Composition and Ownership

Recommended placement: People development. Own published courses, versioned enrollments and completion evidence. Staff and member audiences remain distinct even within shared navigation. CanOnboard references completion through a scoped capability instead of copying a writable progress flag. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.

### Authored audience and progress contract

Enrollment now checks the actual version audience. Staff admission requires current staff eligibility at an applicable location; member admission uses a current paid, eligible CanMember term at an applicable location. Lesson reads and acknowledgments repeat current audience checks, so expired membership or removed staff access cannot be bypassed with an old enrollment link. Instructors are limited to their authorized version locations.

Enrollment freezes its lesson total. Withdrawn learners can still read their own version metadata and acknowledgment evidence without retaining lesson-content access; progress remains based on the frozen total. Repeating acknowledgment of the same lesson returns the existing saved state instead of creating another completion. Draft and published lesson positions are unique within their owner.

The exported canonical `progress(enrollment)` read returns only the exact authorized enrollment/version and its counts. Consumers bind that typed operation under the learner's or instructor's existing authority; it grants no unrestricted HR access or writable completion flag. The instructor's selected-version enrollment/completion tables use the standard permission-scoped CSV export. No enrollment email was added: the requirements explicitly specify no background actions for this version. The old backlog item requesting enrollment notices was not an app requirement.

Inline examples distinguish staff and member enrollment, unpaid member rejection, withdrawal and duplicate acknowledgment. These remain authored expectations rather than executed tests.

### October 4 draft correspondence correction

Personal configuration now declares permitted location/audience choices and due/title list ordering, using the shared preference-order contract rather than duplicate list variants. The own-enrollment query applies those choices; instructor authoring uses the same saved audience/location. Overdue means an active, incomplete enrollment past its due date, not a completed or withdrawn history row. The inaccessible-content card explains withdrawal/current eligibility loss while retaining attributed acknowledgments; sorted split lesson selection and Boolean acknowledgment display reuse canonical components. No frontend business state or extra page shell is added.

A named instructor and learner with real current Employee grants author one course/lesson, publish, enroll, reject instructor acknowledgment, acknowledge twice without duplication, edit the draft, publish/enroll a new version, reject a cross-version lesson, withdraw and read the exact retained original progress. This one attached 14-call journey establishes authored causal expectations for unchanged old content/denominator and preserved completion; it remains unexecuted. Existing staff/member, unpaid-term and isolated withdrawal examples remain. Live publication/enrollment requires lessons; the zero-denominator rule is defensive for retained/imported historical snapshots, not permission to publish an empty live course.

The syntax prototype does not implement attached sequences or preference ordering. A temporary projection excludes the sequence and reduces only the preference order object to its default selector list to check surrounding declarations/legacy tables. No matching MJS target exists for this app; none is added solely for symmetry. These checks do not execute learning, verify rendered accessibility or certify every runtime acceptance case.
