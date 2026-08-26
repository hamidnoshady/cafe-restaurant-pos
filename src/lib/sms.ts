export interface SmsProvider {
  sendOtp(phoneE164: string, otp: string): Promise<void>;
}

export class NoopProvider implements SmsProvider {
  async sendOtp(phoneE164: string, otp: string): Promise<void> {
    console.log(`[SMS NOOP] To: ${phoneE164} OTP: ${otp}`);
  }
}
