// Plan checks of the warehouse module (docs/WAREHOUSE-DESIGN.md Appendix B): trucks and doors (M1), calendar (M2), racks and aisles (M3),
// plans (M4), load types (M5). Called once by validateLayout (validate.js) after its own checks, with the same context and `add`.
//
//   validateOps(ctx, add)   ctx is the internal context of validate.js (layout, docks by station, graph …); `add(severity, code, ref,
//                           message, hint, refs)` records an issue with the stable id `${code}:${ref}`.
//
// STATE (milestone M0): empty. OPS_CHECKS is the list of checks to run, in order; each is (ctx, add) => void and runs only on layouts
// that use the feature it checks (it returns at once for a legacy plant, so a legacy plant gets no new issue).

/** The checks of the warehouse module, in the order their issues are recorded. Empty until M1. */
export const OPS_CHECKS = [];

/** Run every check of the warehouse module. */
export function validateOps(ctx, add) {
  for (const check of OPS_CHECKS) check(ctx, add);
}
