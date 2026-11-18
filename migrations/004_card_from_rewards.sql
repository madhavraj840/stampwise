-- The card has as many stamps as the shop's biggest reward (1 to 30), so it is no longer set by hand.
ALTER TABLE shops DROP CONSTRAINT IF EXISTS shops_card_size_check;
ALTER TABLE shops ADD CONSTRAINT shops_card_size_check CHECK (card_size BETWEEN 1 AND 30);
UPDATE shops s SET card_size = m.n
FROM (SELECT shop_id, max(stamps_required) n FROM rewards WHERE active GROUP BY shop_id) m
WHERE m.shop_id = s.id AND s.card_size <> m.n;
