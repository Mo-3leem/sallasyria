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