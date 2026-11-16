-- Optional auxiliary appliances documented in an orthodontic adjustment session.
-- Owner decision #483 (2026-11-13); number allocated by the integration reviewer (#483 6867852606).
-- Documentation only, never a treatment recommendation. Nothing is backfilled: every existing session
-- keeps NULL, which reads as "not recorded". An empty array is an explicit record of no auxiliary
-- appliance. auxiliary_other holds the name typed for the "other" choice and exists only with it.
ALTER TABLE ortho_adjustments ADD COLUMN auxiliaries TEXT[];
ALTER TABLE ortho_adjustments ADD COLUMN auxiliary_other TEXT;
CREATE FUNCTION ortho_adjustment_auxiliaries_valid(list TEXT[], other TEXT) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT CASE WHEN list IS NULL THEN other IS NULL
  ELSE list = ARRAY(SELECT c.k FROM unnest(ARRAY['hyrax_marpe','nance_button','tpa','tad','closed_coil_niti',
      'open_coil','power_chain','laceback_bendback','bite_turbo','carriere_motion','herbst','forsus',
      'twin_block','lip_bumper','lingual_holding_arch','quad_helix','other']::text[]) WITH ORDINALITY AS c(k,o)
      WHERE c.k = ANY(list) ORDER BY c.o)
   AND ('other' = ANY(list)) = (other IS NOT NULL)
   AND (other IS NULL OR (other = btrim(other) AND char_length(other) BETWEEN 1 AND 80))
 END
$$;
ALTER TABLE ortho_adjustments ADD CONSTRAINT ortho_adjustments_auxiliaries_valid
 CHECK (ortho_adjustment_auxiliaries_valid(auxiliaries, auxiliary_other));
