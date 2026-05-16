-- =====================================================================
-- Al-Fahad Ice — seed data for development.
-- Run with: supabase db reset (or psql)
-- =====================================================================

-- Factory ----------------------------------------------------------------
insert into factories (id, name, code, active)
values ('00000000-0000-0000-0000-000000000001', 'Main Factory', 'F001', true)
on conflict (id) do nothing;

-- Products ---------------------------------------------------------------
insert into products (id, sku, name, unit, weight_kg, active) values
  ('10000000-0000-0000-0000-000000000001', 'ICE-3KG',  'Ice Bag 3kg',  'bag',   3.0, true),
  ('10000000-0000-0000-0000-000000000002', 'ICE-5KG',  'Ice Bag 5kg',  'bag',   5.0, true),
  ('10000000-0000-0000-0000-000000000003', 'ICE-25KG', 'Ice Block 25kg','block',25.0, true)
on conflict (id) do nothing;

-- Default price list -----------------------------------------------------
insert into price_lists (id, name, active)
values ('20000000-0000-0000-0000-000000000001', 'Standard', true)
on conflict (id) do nothing;

insert into price_list_items (id, price_list_id, product_id, unit_price) values
  ('21000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001',  3.00),
  ('21000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000002',  5.00),
  ('21000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000003', 22.00)
on conflict (id) do nothing;

-- Vehicles ---------------------------------------------------------------
insert into vehicles (id, plate_number, label, capacity_kg, factory_id, active) values
  ('30000000-0000-0000-0000-000000000001', 'AB-1234', 'Truck 1', 2000,
   '00000000-0000-0000-0000-000000000001', true),
  ('30000000-0000-0000-0000-000000000002', 'CD-5678', 'Truck 2', 1500,
   '00000000-0000-0000-0000-000000000001', true)
on conflict (id) do nothing;

-- Sample customers -------------------------------------------------------
insert into customers (id, code, name, phone, region, credit_limit, balance, active) values
  ('40000000-0000-0000-0000-000000000001', 'C0001', 'Coastal Café',  '+1000000001', 'North',    500, 0, true),
  ('40000000-0000-0000-0000-000000000002', 'C0002', 'Sunset Hotel',  '+1000000002', 'Downtown', 2000, 0, true),
  ('40000000-0000-0000-0000-000000000003', 'C0003', 'Beach Market',  '+1000000003', 'East',     1000, 0, true)
on conflict (id) do nothing;
