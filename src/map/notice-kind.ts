// What a notice means to a mariner — a SEMANTIC classification, independent of
// whether the notice carries plottable geometry. Either kind can be text-only
// (e.g. "VHF port frequency changed to 14") or carry an area with coordinates
// (e.g. "stay clear of the firing range bounded by …").
export enum NoticeKind {
  // A hazard/restriction a mariner must act on: firing, prohibited/restricted
  // areas, dangers, diving operations.
  ALERT = 'alert',
  // Informational/administrative: chart corrections, amendments, cancellations,
  // cumulative lists.
  INFO = 'info',
}
