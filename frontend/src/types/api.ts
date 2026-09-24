export interface User {
  id: string;
  phone: string;
  email: string | null;
  name: string;
  role: string;
  email_verified: number;
}

export interface LoginResponse {
  user: User;
  must_rotate: boolean;
}

export interface RegisterRequest {
  email: string;
  phone: string;
  password: string;
  name: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface VerifyEmailRequest {
  token: string;
}

export interface ForgotPasswordRequest {
  email: string;
}

export interface ResetPasswordRequest {
  token: string;
  new_password: string;
  logout_other_sessions?: boolean;
}

export interface ChangePasswordRequest {
  current_password: string;
  new_password: string;
  logout_other_sessions?: boolean;
}

export interface UpdateProfileRequest {
  name?: string;
  email?: string | null;
  phone?: string;
  current_password?: string;
  logout_other_sessions?: boolean;
}

export interface ApiError {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: Array<{ field: string; message: string }>;
  };
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export interface Store {
  id: string;
  slug: string;
  name: string;
  currency: string;
  status: string;
  is_published: number;
}

export interface Plan {
  id: string;
  code: string;
  name: string;
  price_monthly: number;
  price_yearly: number;
  max_products: number | null;
}

export interface Category {
  id: string;
  store_id: string;
  parent_id: string | null;
  name: string;
  slug: string;
  sort_order: number;
  is_active: number;
}

export interface Product {
  id: string;
  store_id: string;
  category_id: string | null;
  name: string;
  slug: string;
  description: string | null;
  price: number;
  stock_quantity: number | null;
  is_active: number;
  deleted_at: string | null;
  removed_at: string | null;
}

export interface ProductImage {
  id: string;
  store_id: string;
  product_id: string;
  url: string;
  alt_text: string | null;
  sort_order: number;
  deleted_at: string | null;
}

export interface Customer {
  id: string;
  store_id: string;
  name: string;
  phone: string;
  email: string | null;
}

export interface CustomerAddress {
  id: string;
  store_id: string;
  customer_id: string;
  recipient_name: string;
  phone: string;
  governorate: string;
  city: string | null;
  address_line: string;
  is_default: number;
}

export interface ShippingRate {
  id: string;
  store_id: string;
  governorate: string;
  shipping_method: string;
  cost: number;
  is_active: number;
}

export interface Order {
  id: string;
  store_id: string;
  order_number: number;
  status: string;
  subtotal: number;
  discount: number;
  total: number;
  payment_method: string;
  payment_status: string;
  customer_name: string;
  customer_phone: string;
  shipping_method: string;
  shipping_cost: number;
  shipping_governorate: string;
  shipping_address: string;
}

export interface OrderItem {
  id: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
}

export interface Subscription {
  id: string;
  store_id: string;
  plan_id: string;
  status: string;
  billing_period: string;
  price_amount: number;
  starts_at: string | null;
  ends_at: string | null;
  cancelled_at: string | null;
  payment_reference: string | null;
}