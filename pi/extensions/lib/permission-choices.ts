// Labels shared by every permission prompt, kept free of pi imports so pure modules and their
// tests can use them without resolving the pi packages.
export const ALLOW_ONCE = "Allow once";
export const ALLOW_SESSION = "Allow in session";
export const ALLOW_ALWAYS = "Allow always";
export const DENY_ONCE = "Deny once";
export const DENY_SESSION = "Deny in session";
export const DENY_ALWAYS = "Deny always";
