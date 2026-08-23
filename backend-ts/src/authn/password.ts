import bcrypt from "bcryptjs";

export const bcryptCost = 10;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, bcryptCost);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
