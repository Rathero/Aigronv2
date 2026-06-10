-- 001: sanea display_name existentes (los nombres se renderizan en el HTML de
-- otros jugadores; a partir de ahora se sanean al escribir, esto limpia lo viejo).
UPDATE users
   SET display_name = COALESCE(NULLIF(left(btrim(regexp_replace(display_name, '[<>&"''`\\/]|[\x01-\x1f\x7f]', '', 'g')), 24), ''), 'Jugador')
 WHERE display_name ~ '[<>&"''`\\/]|[\x01-\x1f\x7f]';
