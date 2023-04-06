import { redis } from '../redis/client';
import md5 from 'spark-md5';
import { generateRandomSixDigitNumber } from './utils';
import { AccessControlDAL } from './access_control';
import { Role, Plan, Model, Register } from './typing';

export class UserDAL {
  email: string;

  constructor(email: string) {
    this.email = email.trim().toLowerCase();
  }

  get accessControl(): AccessControlDAL {
    return new AccessControlDAL(this.email);
  }

  get userKey(): string {
    return `user:${this.email}`;
  }

  private async get(...paths: string[]): Promise<(any | null)[]> {
    if (!paths.length) paths.push('$');
    return await redis.json.get(this.userKey, ...paths);
  }

  private set(data: Model.User): Promise<boolean> {
    return this.update('$', data);
  }

  private async update(path: string, data: any): Promise<boolean> {
    return (await redis.json.set(this.userKey, path, data!)) === 'OK';
  }

  private async append(path: string, value: any): Promise<boolean> {
    return (await redis.json.arrappend(this.userKey, path, value)).every(
      code => code !== null
    );
  }

  async exists(): Promise<boolean> {
    return (await redis.exists(this.userKey)) > 0;
  }

  async delete(): Promise<boolean> {
    return (await redis.del(this.userKey)) > 0;
  }

  static async fromRegistration(
    email: string,
    password: string,
    extraData: Partial<Model.User> = {}
  ): Promise<UserDAL | null> {
    const userDAL = new UserDAL(email);

    if (await userDAL.exists()) return null;

    await userDAL.set({
      name: 'Anonymous',
      passwordHash: md5.hash(password.trim()),
      createdAt: Date.now(),
      lastLoginAt: Date.now(),
      isBlocked: false,
      resetChances: 0,
      invitationCodes: [],
      subscriptions: [],
      role: 'user',
      ...extraData,
    });

    return userDAL;
  }

  async login(password: string): Promise<boolean> {
    const [passwordHash] = await this.get('$.passwordHash');
    const isSuccess = passwordHash === md5.hash(password.trim());

    if (isSuccess) {
      // Set last login
      await this.update('$.lastLoginAt', Date.now());
    }
    return isSuccess;
  }

  async getPlan(): Promise<Role | Plan> {
    const [role] = await this.get('$.role');
    if (role === 'user') {
      const subscription = await this.getLastSubscription()
      return  subscription?.plan ?? 'free'
    }
    return  role
  }

  /**
   * 请求(邮箱|手机)激活码, 速率请求由 Cloudflare 规则限制
   * @param codeType Email or Phone
   * @param phone if Phone type, phone number is required
   * @return {
   *   status:
   *   code: register code
   *   ttl:  ttl of the (exist) code
   * }
   */
  async newRegisterCode(
    codeType: Register.CodeType,
    phone?: string
  ): Promise<
    | {
    status: Register.ReturnStatus.Success;
    code: number;
    ttl: number;
  }
    | {
    status: Register.ReturnStatus.TooFast;
    ttl: number;
  }
    | {
    status:
      | Register.ReturnStatus.AlreadyRegister
      | Register.ReturnStatus.UnknownError;
  }
  > {
    if (codeType === 'phone') {
      if (!phone) throw new Error('Phone number is required');
      // Fixme @peron
      // The following code is not possible in Redis

      // if (someUser.hasSamePhone) {
      //   return { status: Register.ReturnStatus.AlreadyRegister };
      // }
    }

    const key = `register:code:${codeType}:${phone ?? this.email}`;
    const code = await redis.get<number>(key);

    // code is found
    if (code) {
      const ttl = await redis.ttl(key);
      if (ttl >= 60 * 4) return { status: Register.ReturnStatus.TooFast, ttl };
    }

    // code is not found, generate a new one
    const randomNumber = generateRandomSixDigitNumber();
    if ((await redis.set(key, randomNumber)) === 'OK') {
      await redis.expire(key, 60 * 5); // Expiration time: 5 minutes
      return {
        status: Register.ReturnStatus.Success,
        code: randomNumber,
        ttl: 300,
      };
    }

    return { status: Register.ReturnStatus.UnknownError };
  }

  /**
   * 激活激活码, 手机号则进入数据库
   * @param code
   * @param codeType
   * @param phone
   */
  async activateRegisterCode(
    code: string | number,
    codeType: Register.CodeType,
    phone?: string
  ): Promise<boolean> {
    if (codeType === 'phone' && !phone) {
      throw new Error('Phone number is required');
    }
    const key = `register:code:${codeType}:${phone ?? this.email}`;
    const remoteCode = await redis.get(key);

    const isSuccess = remoteCode == code;

    if (isSuccess) {
      const delKey = redis.del(key);
      const storePhone = phone && this.update('$.phone', phone);

      await Promise.all([delKey, storePhone]);
    }

    return isSuccess;
  }

  /**
   * Generate a new invitation code, create related key in Redis, and append the code to the user's invitationCodes.
   * Please make sure the user exists before calling this method!
   * @param type the type of the invitation code
   * @returns the invitation code
   */
  async newInvitationCode(type: string): Promise<string> {
    const code = md5.hash(this.email + Date.now());
    const key = `invitationCode:${code}`;

    const invitationCode: Model.InvitationCode = {
      inviterEmail: this.email,
      inviteeEmails: [],
      type,
    };

    const setCode = redis.json.set(key, '$', invitationCode);
    const appendCode = this.append('$.invitationCodes', code);
    await Promise.all([setCode, appendCode]);

    return code;
  }

  /**
   * The following method does the following:
   * 1. Check if the inviter code is valid
   * 2. Set the inviter code to the user
   * 3. Append the email of invitee to the list in the code's inviteeEmails
   * 4. Find the email of inviter
   * 5. Return the email of inviter
   * Please make sure the user exists before calling this method!
   * @param code
   * @returns the info of invitation code
   */
  async acceptInvitationCode(
    code: string
  ): Promise<Model.InvitationCode | null> {
    const inviterCodeKey = `invitationCode:${code}`;
    const inviterCode: Model.InvitationCode = await redis.json.get(
      inviterCodeKey,
      '$'
    );
    if (!inviterCode) return null;

    const setCode = this.update('$.inviterCode', code);
    const appendEmail = redis.json.arrappend(
      inviterCodeKey,
      '$.inviteeEmails',
      this.email
    );

    await Promise.all([setCode, appendEmail]);

    return inviterCode;
  }

  async getInviterCode(): Promise<string | null> {
    return (await this.get('$.inviterCode'))[0] ?? null;
  }

  /**
   * 获取自己的邀请码列表
   */
  async getInvitationCodes(): Promise<string[]> {
    return (await this.get('$.invitationCodes'))[0] ?? [];
  }

  async getResetChances(): Promise<number> {
    return (await this.get('$.resetChances'))[0] ?? -1;
  }

  async changeResetChancesBy(value: number): Promise<boolean> {
    return (
      await redis.json.numincrby(this.userKey, '$.resetChances', value)
    ).every(code => code !== null);
  }

  /**
   * Add a new subscription.
   * Please make sure the user exists before calling this method!
   * @param subscription
   * @returns true if succeeded
   */
  newSubscription(subscription: Model.Subscription): Promise<boolean> {
    return this.append('$.subscriptions', subscription);
  }

  /**
   * Get the last subscription.
   * Please make sure the user exists before calling this method!
   * @returns the current subscription or null if no subscription (Free)
   */
  async getLastSubscription(): Promise<Model.Subscription|null> {
    return (await this.get('$.subscriptions[-1]'))[0] ?? null;
  }
}