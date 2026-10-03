import { readFile } from 'node:fs/promises';
import {
  userSeedFileSchema,
  addressSeedFileSchema,
  categorySeedFileSchema,
  productSeedFileSchema,
  productImageSeedFileSchema,
  productVariantSeedFileSchema,
  cartFileSchema,
  cartItemFileSchema,
  orderFileSchema,
  orderItemFileSchema,
  paymentFileSchema,
  reviewFileSchema,
} from './seed-schema.js';
import { seedTable } from './seed-table.js';
import {
  users,
  addresses,
  products,
  productVariants,
  productImages,
  categories,
  carts,
  cartItems,
  orders,
  orderItems,
  payments,
  reviews,
} from './schema.js';

const USERS_SOURCE = new URL('../../data/users.json', import.meta.url);
const ADDRESSES_SOURCE = new URL('../../data/addresses.json', import.meta.url);
const CATEGORIES_SOURCE = new URL('../../data/categories.json', import.meta.url);
const PRODUCTS_SOURCE = new URL('../../data/products.json', import.meta.url);
const PRODUCT_IMAGES_SOURCE = new URL('../../data/product_images.json', import.meta.url);
const PRODUCT_VARIANTS_SOURCE = new URL('../../data/product_variants.json', import.meta.url);
const CARTS_SOURCE = new URL('../../data/carts.json', import.meta.url);
const CART_ITEMS_SOURCE = new URL('../../data/cart_items.json', import.meta.url);
const ORDERS_SOURCE = new URL('../../data/orders.json', import.meta.url);
const ORDER_ITEMS_SOURCE = new URL('../../data/order_items.json', import.meta.url);
const REVIEWS_SOURCE = new URL('../../data/reviews.json', import.meta.url);
const PAYMENTS_SOURCE = new URL('../../data/payments.json', import.meta.url);

async function readSeedFile(sourceFile: URL) {
  const raw: unknown = JSON.parse(await readFile(sourceFile, 'utf8'));
  return raw;
}

try {
  // Users
  const usersRawData = await readSeedFile(USERS_SOURCE);
  const usersData = userSeedFileSchema.parse(usersRawData);
  console.log('Seeding users...');
  await seedTable(users, usersData, users.id);

  // Addresses
  const addressesRawData = await readSeedFile(ADDRESSES_SOURCE);
  const addressesData = addressSeedFileSchema.parse(addressesRawData);
  console.log('Seeding addresses...');
  await seedTable(addresses, addressesData, addresses.id);

  // Categories
  const categoriesRawData = await readSeedFile(CATEGORIES_SOURCE);
  const categoriesData = categorySeedFileSchema.parse(categoriesRawData);
  console.log('Seeding categories...');
  await seedTable(categories, categoriesData, categories.id);

  // Products
  const productsRawData = await readSeedFile(PRODUCTS_SOURCE);
  const productsData = productSeedFileSchema.parse(productsRawData);
  console.log('Seeding products...');
  await seedTable(products, productsData, products.id);

  // Product Images
  const productImagesRawData = await readSeedFile(PRODUCT_IMAGES_SOURCE);
  const productImagesData = productImageSeedFileSchema.parse(productImagesRawData);
  console.log('Seeding product images...');
  await seedTable(productImages, productImagesData, productImages.id);

  // Product Variants
  const productVariantsRawData = await readSeedFile(PRODUCT_VARIANTS_SOURCE);
  const productVariantsData = productVariantSeedFileSchema.parse(productVariantsRawData);
  console.log('Seeding product variants...');
  await seedTable(productVariants, productVariantsData as any, productVariants.id);

  // Carts
  const cartsRawData = await readSeedFile(CARTS_SOURCE);
  const cartsData = cartFileSchema.parse(cartsRawData);
  console.log('Seeding carts...');
  await seedTable(carts, cartsData, carts.id);

  // Cart Items
  const cartItemsRawData = await readSeedFile(CART_ITEMS_SOURCE);
  const cartItemsData = cartItemFileSchema.parse(cartItemsRawData);
  console.log('Seeding cart items...');
  await seedTable(cartItems, cartItemsData, cartItems.id);

  // Orders
  const ordersRawData = await readSeedFile(ORDERS_SOURCE);
  const ordersData = orderFileSchema.parse(ordersRawData);
  console.log('Seeding orders...');
  await seedTable(orders, ordersData, orders.id);

  // Order Items
  const orderItemsRawData = await readSeedFile(ORDER_ITEMS_SOURCE);
  const orderItemsData = orderItemFileSchema.parse(orderItemsRawData);
  console.log('Seeding order items...');
  await seedTable(orderItems, orderItemsData as any, orderItems.id);

  // Payments
  const paymentsRawData = await readSeedFile(PAYMENTS_SOURCE);
  const paymentsData = paymentFileSchema.parse(paymentsRawData);
  console.log('Seeding payments...');
  await seedTable(payments, paymentsData, payments.id);

  // Reviews
  const reviewsRawData = await readSeedFile(REVIEWS_SOURCE);
  const reviewsData = reviewFileSchema.parse(reviewsRawData);
  console.log('Seeding reviews...');
  await seedTable(reviews, reviewsData, reviews.id);
} catch (err: unknown) {
  if (err instanceof Error) {
    console.error('❌ Seeding Failed', err.message);
  } else {
    console.error('❌ Seeding Failed');
  }
}
