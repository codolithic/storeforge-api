import { z } from 'zod';

const userSeedSchema = z.object({
  id: z.number().int().positive(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.email(),
  passwordHash: z.string(),
  role: z.enum(['customer', 'admin']),
  createdAt: z.string().nonempty(),
  updatedAt: z.string().nonempty(),
});

const addressSeedSchema = z.object({
  id: z.number().int().positive(),
  userId: z.number().int().positive(),
  line1: z.string().nonempty(),
  line2: z.string().nullable(),
  city: z.string().nonempty(),
  state: z.string().nonempty(),
  postalCode: z.string().nonempty(),
  country: z.string().nonempty().default('Australia'),
  isDefault: z.boolean(),
});

const categorySeedSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  slug: z.string().min(1),
  parentId: z.number().int().positive().nullable().optional(),
});

const productSeedSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().nullable().optional(),
  basePrice: z.number().positive(),
  categoryId: z.number().int().positive(),
  status: z.enum(['active', 'draft', 'archived']),
});

const productImageSeedSchema = z.object({
  id: z.number().int().positive(),
  productId: z.number().int().positive(),
  url: z.url(),
});

const productVariantSeedSchema = z.object({
  id: z.number().int().positive(),
  productId: z.number().int().positive(),
  sku: z.string(),
  price: z.float32(),
  attributes: z.json().nullable(),
  stockQuantity: z.number().int().min(0),
});

const cartSchema = z.object({
  id: z.number().int().positive(),
  userId: z.number().int().positive().nullable(),
  sessionId: z.string().nullable(),
  status: z.enum(['active', 'converted', 'abandoned']),
  createdAt: z.string().nonempty(),
});

const cartItemSchema = z.object({
  id: z.number().int().positive(),
  cartId: z.number().int().positive(),
  variantId: z.number().int().positive(),
  quantity: z.number().positive(),
  unitPriceSnapshot: z.float32().positive(),
});

const orderSchema = z.object({
  id: z.number().int().positive(),
  userId: z.number().int().positive(),
  status: z.enum(['pending', 'paid', 'fulfilled', 'cancelled', 'refunded']),
  subtotal: z.float32().positive(),
  tax: z.float32().positive(),
  shippingFee: z.float32().min(0.0),
  total: z.float32().positive(),
  shippingAddressId: z.number().int().positive(),
  createdAt: z.string().nonempty(),
  updatedAt: z.string().nonempty(),
});

const orderItemSchema = z.object({
  id: z.number().int().positive(),
  orderId: z.number().int().positive(),
  variantId: z.number().int().positive(),
  productName: z.string().nonempty(),
  variantAttributes: z.json().nullable(),
  unitPrice: z.float32().positive(),
  quantity: z.number().int().positive(),
});

const paymentSchema = z.object({
  id: z.number().int().positive(),
  orderId: z.number().int().positive(),
  provider: z.string().nonempty(),
  providerRef: z.string().nonempty(),
  status: z.enum(['pending', 'succeeded', 'failed', 'refunded']),
  amount: z.float64().positive(),
  createdAt: z.string().nonempty(),
});

const reviewSchema = z.object({
  id: z.number().int().positive(),
  productId: z.number().int().positive(),
  userId: z.number().int().positive(),
  rating: z.number().int().positive(),
  comment: z.string().nullable().default(null),
  createdAt: z.string().nonempty(),
});

export const userSeedFileSchema = z.array(userSeedSchema).min(1);
export const addressSeedFileSchema = z.array(addressSeedSchema).min(1);
export const categorySeedFileSchema = z.array(categorySeedSchema).min(1);
export const productSeedFileSchema = z.array(productSeedSchema).min(1);
export const productImageSeedFileSchema = z.array(productImageSeedSchema).min(1);
export const productVariantSeedFileSchema = z.array(productVariantSeedSchema).min(1);
export const cartFileSchema = z.array(cartSchema).min(1);
export const cartItemFileSchema = z.array(cartItemSchema).min(1);
export const orderFileSchema = z.array(orderSchema).min(1);
export const orderItemFileSchema = z.array(orderItemSchema).min(1);
export const reviewFileSchema = z.array(reviewSchema).min(1);
export const paymentFileSchema = z.array(paymentSchema).min(1);
