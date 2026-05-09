CREATE OR REPLACE FUNCTION public.update_collection_lv2_on_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  lv2 text;
BEGIN
  IF position('.' in NEW.collection) > 0 THEN
    lv2 :=
      split_part(NEW.collection, '.', 1) || '.' ||
      split_part(NEW.collection, '.', 2);

    INSERT INTO public.collection_lv2 (nsidlv2)
    VALUES (lv2)
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NULL;
END;
$function$;
