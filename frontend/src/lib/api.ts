import type { ApiResponse, ApiError } from "@/types/api";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8787";

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const url = `${API_BASE_URL}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
    credentials: "include",
  });

  const data = await response.json();

  if (!response.ok || data.ok === false) {
    return data as ApiError;
  }

  return data as ApiResponse<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: "GET" }),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

export const authApi = {
  register: (data: {
    email: string;
    phone: string;
    password: string;
    name: string;
  }) => api.post<{ user: { id: string; phone: string; email: string | null; name: string; role: string; email_verified: number } }>("/auth/register", data),

  login: (data: { email: string; password: string }) =>
    api.post<{ user: { id: string; phone: string; email: string | null; name: string; role: string; email_verified: number }; must_rotate: boolean }>("/auth/login", data),

  logout: () => api.post<{ loggedOut: boolean }>("/auth/logout", {}),

  logoutOthers: () => api.post<{ revoked: number }>("/auth/logout-others", {}),

  me: () => api.get<{ user: { id: string; phone: string; email: string | null; name: string; role: string; email_verified: number } }>("/auth/me"),

  updateProfile: (data: {
    name?: string;
    email?: string | null;
    phone?: string;
    current_password?: string;
    logout_other_sessions?: boolean;
  }) =>
    api.patch<{ user: { id: string; phone: string; email: string | null; name: string; role: string; email_verified: number }; reauth_required: boolean }>("/auth/me", data),

  changePassword: (data: {
    current_password: string;
    new_password: string;
    logout_other_sessions?: boolean;
  }) => api.post<{ changed: boolean }>("/auth/change-password", data),

  verifyEmail: (token: string) =>
    api.post<{ verified: boolean }>("/auth/verify-email", { token }),

  resendVerification: (email: string) =>
    api.post<{ emailed: boolean }>("/auth/resend-verification", { email }),

  forgotPassword: (email: string) =>
    api.post<{ emailed: boolean }>("/auth/forgot-password", { email }),

  resetPassword: (data: {
    token: string;
    new_password: string;
    logout_other_sessions?: boolean;
  }) => api.post<{ reset: boolean }>("/auth/reset-password", data),
};