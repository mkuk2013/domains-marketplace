export const ADMIN_EMAIL = "mkuk2013@gmail.com";

export function isAdmin(user) {
  return (user?.email ?? "").toLowerCase() === ADMIN_EMAIL && Boolean(user?.email_confirmed_at);
}
