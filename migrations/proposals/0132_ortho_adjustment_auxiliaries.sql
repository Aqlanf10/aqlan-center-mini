-- Proposal 0132: Optional auxiliary appliances documented in an orthodontic adjustment session.
-- Coordinated in MIGRATION_COORDINATION.md for DOT registration.
ALTER TABLE ortho_adjustments ADD COLUMN IF NOT EXISTS auxiliaries TEXT[];
ALTER TABLE ortho_adjustments ADD COLUMN IF NOT EXISTS auxiliary_other TEXT;

CREATE OR REPLACE FUNCTION ortho_adjustment_auxiliaries_valid(list TEXT[], other TEXT) RETURNS boolean
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
