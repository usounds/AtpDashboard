CREATE OR REPLACE FUNCTION public.unique_did_insert_trg()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO public.unique_did (did)
  VALUES (NEW.did)
  ON CONFLICT DO NOTHING;

  RETURN NULL;
END;
$function$;
