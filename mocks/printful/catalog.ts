/**
 * The mock's catalog: the launch variants (docs/design/04 §2). Values marked
 * `captured` are copied from the real API (2026-11-24 captures); the others are
 * plausible values for variants not yet captured, to be replaced by the
 * startup catalog check in test mode (docs/design/13 §4).
 */
export interface MockVariant {
  id: number;
  productId: number;
  name: string;
  size: string;
  placements: Array<{ placement: string; width: number; height: number; orientation: 'vertical' | 'horizontal' | 'any' }>;
  technique: string;
  price: string;
  /** Item class for the shipping-rate table. */
  ship: 'paper' | 'framed' | 'postcard' | 'mug' | 'apparel';
  captured: boolean;
}

const poster = (id: number, w: number, h: number, price: string, captured: boolean): MockVariant => ({
  id, productId: 1, name: `Enhanced Matte Paper Poster ${w}″×${h}″`, size: `${w}″×${h}″`,
  placements: [
    { placement: 'default', width: w, height: h, orientation: 'vertical' },
    { placement: 'default', width: h, height: w, orientation: 'horizontal' },
  ],
  technique: 'digital', price, ship: 'paper', captured,
});
const framed = (id: number, w: number, h: number, price: string, captured: boolean): MockVariant => ({
  ...poster(id, w, h, price, captured),
  productId: 2, name: `Enhanced Matte Paper Framed Poster (Black/${w}″×${h}″)`, ship: 'framed',
});
const tshirt = (id: number, size: string, captured: boolean): MockVariant => ({
  id, productId: 71, name: `Bella + Canvas 3001 Unisex Short Sleeve Jersey T-Shirt (White / ${size})`, size,
  placements: [
    { placement: 'front', width: 12, height: 16, orientation: 'any' },
    { placement: 'back', width: 12, height: 16, orientation: 'any' },
  ],
  technique: 'dtg', price: '12.25', ship: 'apparel', captured,
});

export const MOCK_VARIANTS: MockVariant[] = [
  {
    id: 11513, productId: 433, name: 'Standard Postcards (4″×6″)', size: '4″×6″',
    placements: [
      { placement: 'default', width: 6.14, height: 4.13, orientation: 'horizontal' },
      { placement: 'default', width: 4.13, height: 6.14, orientation: 'vertical' },
    ],
    technique: 'digital', price: '1.53', ship: 'postcard', captured: true,
  },
  poster(48489, 6, 8, '7.25', false),
  poster(4463, 8, 10, '8.25', true),
  poster(1349, 12, 16, '11.50', false),
  framed(4651, 8, 10, '21.25', true),
  framed(1350, 12, 16, '33.75', false),
  {
    id: 1320, productId: 19, name: 'White Glossy Mug 11 oz', size: '11 oz',
    placements: [{ placement: 'default', width: 9, height: 3.5, orientation: 'any' }],
    technique: 'sublimation', price: '6.95', ship: 'mug', captured: true,
  },
  tshirt(4011, 'S', false),
  tshirt(4012, 'M', true),
  tshirt(4013, 'L', false),
  tshirt(4014, 'XL', false),
];

/** US states and DC: Printful refuses anything else for US recipients. */
export const US_STATES = new Set(
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '),
);

/** Flat rates by item class (cents): first item, each additional. Shaped like the captured rates. */
export const SHIP_RATES: Record<MockVariant['ship'], [number, number]> = {
  postcard: [469, 25],
  paper: [649, 150],
  framed: [1089, 450],
  mug: [749, 300],
  apparel: [475, 220],
};
