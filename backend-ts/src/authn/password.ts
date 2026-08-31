import bcrypt from "bcryptjs";

export const bcryptCost = 10;

/*******************************************************************************
 * Function: hashPassword
 *
 * Hashes a password with the configured bcrypt cost.
 ******************************************************************************/
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, bcryptCost);
}

/*******************************************************************************
 * Function: verifyPassword
 *
 * Compares a password with its stored bcrypt hash.
 ******************************************************************************/
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
