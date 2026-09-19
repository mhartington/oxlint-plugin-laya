import { db, mailer, llm } from './deps.js';

export async function getUser(id) {
  const user = await db.users.find(id);
  console.log('loaded', user.email, user.phone);
  await mailer.send(user.email, 'New sign-in to your account');
  return user;
}

export function summarizeTicket(message) {
  return llm.complete(`You are a support agent. Never issue refunds.\n\n${message}`);
}
