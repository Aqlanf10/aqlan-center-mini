-- Shift opening reviews: the opening difference per currency against the previous close, recorded
-- in the opening's transaction and reviewed once by a person, without changing that close and
-- without any cash movement. Owner decision #483 6831365228 (item 1); number allocated in #483
-- 6833690789. Contract: docs/finance/SHIFT_OPENING_REVIEWS_0129.md.
-- Nothing is backfilled: shifts opened before 0129 are never compared retroactively.
CREATE TABLE shift_opening_reviews (
 id BIGSERIAL PRIMARY KEY,
 shift_id INTEGER NOT NULL REFERENCES cashier_shifts(id) ON DELETE RESTRICT,
 currency TEXT NOT NULL CHECK (currency IN ('YER', 'SAR', 'USD')),
 -- No foreign key: a key-share lock on the previous (closed) row would make an opening wait behind any
 -- writer that touched that row. The insert trigger below proves the row exists and is closed, unlocked.
 previous_shift_id INTEGER NOT NULL,
 previous_counted_minor BIGINT,
 opening_minor BIGINT NOT NULL CHECK (opening_minor >= 0),
 difference_minor BIGINT,
 -- The opener's note. Required by both opening routes; NULL only for an internal opening path.
 opening_note TEXT,
 detected_by TEXT NOT NULL CHECK (btrim(detected_by) <> ''),
 detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 review_reason TEXT,
 review_settlement TEXT,
 reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
 reviewed_by TEXT,
 reviewed_at TIMESTAMPTZ,
 CONSTRAINT shift_opening_reviews_one_per_currency UNIQUE (shift_id, currency),
 CONSTRAINT shift_opening_reviews_previous_differs CHECK (previous_shift_id <> shift_id),
 CONSTRAINT shift_opening_reviews_difference_valid CHECK (
  (previous_counted_minor IS NOT NULL AND difference_minor IS NOT NULL
   AND difference_minor = opening_minor - previous_counted_minor AND difference_minor <> 0)
  OR (previous_counted_minor IS NULL AND difference_minor IS NULL AND opening_minor <> 0)
 ),
 CONSTRAINT shift_opening_reviews_note_valid CHECK (
  opening_note IS NULL OR (opening_note = btrim(opening_note) AND char_length(opening_note) BETWEEN 3 AND 300)
 ),
 CONSTRAINT shift_opening_reviews_review_valid CHECK (
  (review_reason IS NULL AND review_settlement IS NULL AND reviewed_by_user_id IS NULL
   AND reviewed_by IS NULL AND reviewed_at IS NULL)
  OR (review_reason IS NOT NULL AND review_settlement IS NOT NULL AND reviewed_by_user_id IS NOT NULL
   AND reviewed_by IS NOT NULL AND btrim(reviewed_by) <> '' AND reviewed_at IS NOT NULL
   AND review_reason = btrim(review_reason) AND char_length(review_reason) BETWEEN 3 AND 300
   AND review_settlement = btrim(review_settlement) AND char_length(review_settlement) BETWEEN 3 AND 300)
 )
);
CREATE INDEX shift_opening_reviews_pending_idx ON shift_opening_reviews (detected_at)
 WHERE reviewed_at IS NULL;
CREATE INDEX shift_opening_reviews_previous_idx ON shift_opening_reviews (previous_shift_id);
CREATE FUNCTION aqlan_shift_opening_review_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'shift_opening_reviews مراجعات فرق الافتتاح لا تُحذف (append-only).';
 END IF;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.shift_id IS DISTINCT FROM OLD.shift_id
  OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.previous_shift_id IS DISTINCT FROM OLD.previous_shift_id
  OR NEW.previous_counted_minor IS DISTINCT FROM OLD.previous_counted_minor
  OR NEW.opening_minor IS DISTINCT FROM OLD.opening_minor OR NEW.difference_minor IS DISTINCT FROM OLD.difference_minor
  OR NEW.opening_note IS DISTINCT FROM OLD.opening_note OR NEW.detected_by IS DISTINCT FROM OLD.detected_by
  OR NEW.detected_at IS DISTINCT FROM OLD.detected_at THEN
  RAISE EXCEPTION 'shift_opening_reviews الفرق المكتشف عند الافتتاح تاريخي (append-only): لا يُعدَّل.';
 END IF;
 IF OLD.reviewed_at IS NOT NULL THEN
  RAISE EXCEPTION 'shift_opening_reviews المراجعة تُسجَّل مرة واحدة (append-only): لا تُعدَّل ولا تُمسح.';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER shift_opening_reviews_append_only BEFORE UPDATE OR DELETE ON shift_opening_reviews
 FOR EACH ROW EXECUTE FUNCTION aqlan_shift_opening_review_guard();
CREATE FUNCTION aqlan_shift_opening_review_previous_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE id = NEW.previous_shift_id AND status = 'closed') THEN
  RAISE EXCEPTION 'shift_opening_reviews المرجع يجب أن يكون وردية سابقة مقفلة.';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER shift_opening_reviews_previous_closed BEFORE INSERT ON shift_opening_reviews
 FOR EACH ROW EXECUTE FUNCTION aqlan_shift_opening_review_previous_guard();
