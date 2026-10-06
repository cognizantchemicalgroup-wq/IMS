<?php
/**
 * CCPL ERP - Gmail SMTP Mailer Service
 */

require_once __DIR__ . '/config.php';

use PHPMailer\PHPMailer\PHPMailer;
use PHPMailer\PHPMailer\SMTP;
use PHPMailer\PHPMailer\Exception;

if (isset($_SERVER['SCRIPT_FILENAME']) && realpath(__FILE__) === realpath($_SERVER['SCRIPT_FILENAME'])) {
    http_response_code(403);
    exit('Direct access forbidden');
}

class MailerService {
    /**
     * Send OTP email via Gmail SMTP
     */
    public static function sendOtpEmail(string $recipientEmail, string $otp, string $recipientName = ''): bool {
        $mail = new PHPMailer(true);

        try {
            $host = env('SMTP_HOST', 'smtp.gmail.com');
            $port = (int)env('SMTP_PORT', 587);
            $secure = strtolower(env('SMTP_SECURE', 'tls'));
            $user = env('SMTP_USER', '');
            $pass = env('SMTP_PASS', '');
            $fromEmail = env('SMTP_FROM_EMAIL', '') ?: $user;
            $fromName = env('SMTP_FROM_NAME', 'CCPL IMS');

            if (empty($pass) || empty($user)) {
                error_log("MailerService error: SMTP_USER / SMTP_PASS not configured.");
                return false;
            }

            // Server settings
            $mail->isSMTP();
            $mail->Host       = $host;
            $mail->SMTPAuth   = true;
            $mail->Username   = $user;
            $mail->Password   = $pass;
            $mail->SMTPSecure = ($secure === 'ssl' || $port === 465) ? PHPMailer::ENCRYPTION_SMTPS : PHPMailer::ENCRYPTION_STARTTLS;
            $mail->Port       = $port;
            $mail->Timeout    = 15;
            $mail->CharSet    = 'UTF-8';

            // Recipients
            $mail->setFrom($fromEmail, $fromName);
            $mail->addAddress($recipientEmail, $recipientName ?: $recipientEmail);

            // Subject
            $mail->Subject = 'CCPL IMS - Login Verification Code';

            // Plain text body (exact required wording)
            $plainBody = "Your CCPL IMS verification code is:\n" .
                         "{$otp}\n\n" .
                         "This OTP expires in 5 minutes.\n" .
                         "Do not share this OTP with anyone.\n" .
                         "If you did not attempt to log in, ignore this email.";

            // Styled HTML body
            $htmlBody = '
            <!DOCTYPE html>
            <html>
            <head>
              <meta charset="utf-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>CCPL IMS Verification Code</title>
            </head>
            <body style="margin: 0; padding: 24px; background-color: #f4f5f8; font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, Helvetica, Arial, sans-serif; color: #1e293b;">
              <div style="max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.04);">
                <div style="background: #1e1b4b; padding: 24px 32px; text-align: left;">
                  <h1 style="margin: 0; color: #ffffff; font-size: 20px; font-weight: 700; letter-spacing: -0.3px;">Cognizant Chemical Pvt. Ltd.</h1>
                  <p style="margin: 4px 0 0 0; color: #a5b4fc; font-size: 13px;">Enterprise Resource Planning</p>
                </div>
                <div style="padding: 32px;">
                  <p style="margin: 0 0 16px 0; font-size: 15px; color: #334155; line-height: 1.5;">Your CCPL IMS verification code is:</p>
                  
                  <div style="text-align: center; margin: 28px 0; padding: 18px 24px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 10px;">
                    <span style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 34px; font-weight: 800; letter-spacing: 8px; color: #1e1b4b; display: inline-block;">' . htmlspecialchars($otp, ENT_QUOTES, 'UTF-8') . '</span>
                  </div>

                  <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 12px 16px; border-radius: 6px; margin-bottom: 24px;">
                    <p style="margin: 0; font-size: 13.5px; color: #92400e; font-weight: 500;">
                      This OTP expires in <strong>5 minutes</strong>.<br>
                      Do not share this OTP with anyone.
                    </p>
                  </div>

                  <p style="margin: 0; font-size: 13px; color: #64748b; line-height: 1.5;">
                    If you did not attempt to log in to the CCPL ERP, please ignore this email or notify your system administrator immediately.
                  </p>
                </div>
                <div style="padding: 16px 32px; background: #f8fafc; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; text-align: center;">
                  &copy; ' . date('Y') . ' Cognizant Chemical Pvt. Ltd. All rights reserved.
                </div>
              </div>
            </body>
            </html>';

            $mail->isHTML(true);
            $mail->Body    = $htmlBody;
            $mail->AltBody = $plainBody;

            $mail->send();
            return true;
        } catch (\Throwable $e) {
            error_log("PHPMailer send failed to {$recipientEmail}: " . $mail->ErrorInfo . " | Exception: " . $e->getMessage());
            return false;
        }
    }
}
