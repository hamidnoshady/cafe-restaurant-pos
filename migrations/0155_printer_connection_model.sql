-- ============================================================================
-- 0155_printer_connection_model.sql — the canonical printer hardware model.
--
-- A printer is reached one of exactly two ways, and which one it is is the
-- only hardware question the product asks:
--
--   'windows' — a printer already installed in Windows' own Printers &
--               scanners list (USB thermal printers included); the Cafe POS
--               Windows connector prints it RAW through the spooler.
--   'network' — a LAN/Wi-Fi ESC/POS printer with its own address (raw-print
--               port 9100); the same local connector discovers it and sends
--               over TCP.
--
-- The old five-transport model (`network | system | usb | webusb | browser`)
-- is collapsed into it, in place, inside the same `connection` jsonb column
-- migration 0001 created — no new table, no data destroyed:
--
--   transport='system'                 → {type:'windows', systemName}
--   transport='network', or a pre-transport row with an ip
--                                      → {type:'network', ip, port}
--   transport in ('usb','webusb','browser'), or a stub row with no address
--                                      → unchanged + {needsReconnect:true,
--                                         legacyTransport:...}
--
-- `needsReconnect` rows keep their legacy fields (devicePath, usb ids,
-- systemName, ip…) so the settings screen can show WHICH printer needs
-- re-pairing. New code never writes that shape: the write boundary
-- (src/lib/printing/printer-input.ts) accepts only `windows`/`network`.
--
-- Behavioural fields (paperWidthMm, paper, templateKey, openDrawer,
-- isDefault) ride along untouched — they were never transport information.
-- ============================================================================

-- Windows queues: drop the transport spelling and the address fields a queue
-- never had; keep the queue name and every behavioural field.
UPDATE printers
   SET connection = connection
        - 'transport' - 'ip' - 'port' - 'devicePath'
        - 'usbVendorId' - 'usbProductId' - 'usbSerial' - 'usbProductName'
        - 'driverMode' - 'copies' - 'driver'
        || '{"type":"windows"}'::jsonb
 WHERE jsonb_typeof(connection) = 'object'
   AND connection->>'transport' = 'system';

-- Network printers, explicit or (pre-transport rows) implied by a stored
-- address: keep ip/port as stored (an absent port means 9100 in code) and
-- drop every other transport field.
UPDATE printers
   SET connection = connection
        - 'transport' - 'systemName' - 'devicePath'
        - 'usbVendorId' - 'usbProductId' - 'usbSerial' - 'usbProductName'
        - 'driverMode' - 'copies' - 'driver'
        || '{"type":"network"}'::jsonb
 WHERE jsonb_typeof(connection) = 'object'
   AND (
        connection->>'transport' = 'network'
        OR (connection->>'transport' IS NULL
            AND connection->>'ip' IS NOT NULL
            AND btrim(connection->>'ip') <> '')
   );

-- Everything else (usb / webusb / browser / stub rows with no address):
-- cannot be converted without guessing — flag for one new pairing and keep
-- the identifying fields. IS DISTINCT FROM (not =) because a NULL transport
-- compared with = yields NULL, which would let stub rows slip through the
-- NOT (...) guard via three-valued logic.
UPDATE printers
   SET connection = connection
        - 'transport' - 'driver'
        || jsonb_build_object(
             'needsReconnect', true,
             'legacyTransport', COALESCE(connection->>'transport', 'unknown')
           )
 WHERE jsonb_typeof(connection) = 'object'
   AND NOT (connection ? 'type')
   AND (connection->>'transport') IS DISTINCT FROM 'system'
   AND (connection->>'transport') IS DISTINCT FROM 'network'
   AND NOT (
        connection->>'transport' IS NULL
        AND COALESCE(btrim(connection->>'ip'), '') <> ''
   );
