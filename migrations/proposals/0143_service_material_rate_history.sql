-- Proposal: apply only when rollback and the exact target schema have been reviewed.
CREATE TABLE public.service_material_rate_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  service_id integer NOT NULL REFERENCES public.services(id),
  rate_bp integer CHECK (rate_bp BETWEEN 0 AND 10000),
  effective_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_by text NOT NULL,
  change_reason text NOT NULL CHECK (length(change_reason) BETWEEN 3 AND 300)
);
CREATE INDEX service_material_rate_history_lookup_idx
  ON public.service_material_rate_history (service_id, effective_from DESC, id DESC);
