export const ADMIN_EMAIL = "weblitexagency@gmail.com";

export function isAdmin(user) {
  return (user?.email ?? "").toLowerCase() === ADMIN_EMAIL && Boolean(user?.email_confirmed_at);
}
