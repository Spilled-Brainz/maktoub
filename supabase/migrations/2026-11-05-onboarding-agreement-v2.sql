-- Founder's Founding Client Agreement (5 Nov 2026) as v2, with matching privacy
-- notice and voice consent, plus an optional anonymised-retention consent.
-- v1 rows stay (immutable). Settings point at v2; approval is reset so the founder
-- approves the exact v2 text in /onboard/admin/.
begin;
alter table public.maktoub_legal_documents drop constraint maktoub_legal_documents_kind_check,
  add constraint maktoub_legal_documents_kind_check check (kind in ('agreement','privacy','voice_processing','voice_research'));
alter table public.maktoub_onboarding_consents drop constraint maktoub_onboarding_consents_kind_check,
  add constraint maktoub_onboarding_consents_kind_check check (kind in ('agreement','privacy','voice_processing','voice_research'));
alter table public.maktoub_onboarding_settings add column research_version text;
alter table public.maktoub_onboarding
  add column countersigned_at timestamptz,
  add column countersigned_by uuid,
  add column countersigned_name text;

insert into public.maktoub_legal_documents (version, kind, title, body) values
('MKT-FOUNDING-2026-11-v2', 'agreement', 'Private Matchmaking — Founding Client Agreement', $doc$
This Agreement is between Maktoub.app, founded by Deena Al Jassasi ("Maktoub", "we"), and the client named below ("you"), who has chosen to begin a private, personalised matchmaking journey with us.

Programme Fee: {{FEE}} (Founding Client rate)
Duration: 3–6 months of active matchmaking, beginning on the date your relationship readiness is approved (Section 4).

As a Founding Client, you receive this rate for the full programme and early access to new Maktoub services as they launch. We may invite your feedback to help shape Maktoub.

1. Your Membership
Your programme includes:
- A private founder consultation (completed).
- A confidential intake and voice assessment.
- A personalised voice analysis report, delivered within 7 days of receiving your payment and complete intake submission.
- A follow-up consultation to review your report, discuss recommendations and answer your questions.
- Curated matchmaking, with three introductions to screened, identity-verified, potentially compatible individuals.
- Personalised guidance throughout your programme.
Your voice analysis report offers reflective, relational insight, so that you come out of this programme knowing yourself better, and better prepared for love, than when you began. It is not a psychological, medical or clinical assessment, diagnosis or treatment.

2. What Counts as an Introduction
An introduction takes place when Maktoub presents a potential match to you, you and that person both agree to connect, and contact details are exchanged or a meeting is arranged.
A profile you or the other person decline to pursue is not counted as an introduction. Whether a relationship develops after an introduction is in the hands of the two people involved.

3. Matchmaking & Introductions
Maktoub considers your preferences, values and relationship goals when identifying potential partners. Screening means a personal consultation with each candidate, a review of their stated information, relationship intentions and readiness, and verification of their identity against official identification before any introduction, so you know the person you meet is who they say they are. Unless separately agreed in writing, screening does not include criminal or financial background checks.
Your programme includes three introductions, each chosen carefully around mutual interest and compatibility. Love itself can't be promised, but our commitment to you can: we keep working with you until three introductions have taken place (Section 9).
Introductions may lead to in-person or virtual meetings, according to mutual preference. You may involve a family member or guardian in the process if you wish.
Before any introduction, we will tell you what information will be shared with the other person. Your identity will never be disclosed, and no introduction will be arranged, without your explicit prior approval.

4. Relationship Readiness
Your 3–6 month matchmaking period begins on the day of your report review consultation, once we agree together that you're ready to start.
If further preparation is recommended, we will explain why and guide you through the next steps. Matchmaking, and the programme clock, will pause until you are ready to proceed. Your programme remains valid for up to 12 months from your report review, so your place is held while you prepare.

5. Your Commitments
By joining, you confirm that:
- You are seeking a serious relationship leading to marriage.
- You are legally free to marry, and the information you provide, including your marital status, is true and complete. You will tell us promptly if anything changes.
- You will treat every introduction with respect, honesty and discretion, and keep the other person's information confidential.
- You will share feedback after each introduction so we can refine your search.

6. Safety & Responsibility
Your safety matters deeply to us. We verify the identity of every person before introducing them, and we only introduce people we believe are sincere. We do our very best, but we cannot guarantee another person's conduct, so we encourage first meetings in a public place or virtually. If anything ever feels wrong, tell us straight away and we will act on it.

7. Payment, Refunds & Cancellation
The programme fee of {{FEE}} is payable by bank transfer. Your programme begins as soon as payment is received, so the fee is non-refundable once paid.
Requests to cancel or reschedule an arranged introduction are reviewed individually. Please give at least 48 hours' notice where possible.

8. Privacy & Confidentiality
Your personal information, identity and records are handled securely and confidentially, in line with the Saudi Personal Data Protection Law and our Privacy Notice.
We use your information only to deliver your programme. Only the information you approve is shared with a potential match.
Voice processing: Your voice recording will be analysed by a third-party technology provider, which may be located outside Saudi Arabia. It is sent under a coded identifier, without your name or contact details, and requires your separate consent below.
Retention: We keep your records, including your voice recording, for as long as you are a Maktoub client. With your separate consent, we may also keep your voice recording and report in anonymised form to improve Maktoub's analysis and services. You may ask us at any time to access, correct or delete your information, and we will act on your request.

9. Ending the Programme
Maktoub may end your programme if you provide false information, behave disrespectfully or unsafely towards anyone introduced to you, or breach this Agreement. In that case, no refund is due.
If fewer than three introductions take place within your programme period, your programme will be extended at no extra cost until three introductions have taken place, provided you remain active, responsive and open to the matches we present.

10. Governing Law
This Agreement is governed by the laws of the Kingdom of Saudi Arabia. We will always try to resolve any concern with you directly and in good faith first.

11. Electronic Signature
By typing your full name and selecting "Sign", you sign this Agreement electronically, with the same effect as a handwritten signature. We keep a record of the exact text you signed, the date and time, and a fingerprint of the document, and Maktoub countersigns on receipt. You may ask for a copy at any time.
$doc$),
('MKT-PRIVACY-2026-11-v2', 'privacy', 'Privacy Notice', $doc$
Who we are. Maktoub.app, founded by Deena Al Jassasi ("Maktoub"), is responsible for the personal data you give us during onboarding and your programme.

What we collect. Your contact details, date and time of birth, background and family details, your written intake answers (including how you describe your wellbeing and readiness), your voice recording, your agreement and consent records, and records of your payment.

Why we use it. Only to deliver your programme: preparing your report, holding your consultations, assessing readiness, finding and screening suitable introductions, and keeping the records the law requires. We do not sell your data and we do not use it for advertising.

Who can see it. The Maktoub founder and team members who need it for your programme. Your voice recording is analysed by a third-party technology provider, which may be located outside Saudi Arabia, under a coded identifier without your name or contact details, and only with your separate consent. Your records are stored privately and are never public. Before any introduction, only the information you have explicitly approved is shared, and only with that person.

How long we keep it. For as long as you are a Maktoub client, and afterwards only as long as the law requires, after which it is deleted. If you separately consent, your voice recording and report may be kept in anonymised form to improve Maktoub's analysis and services.

Your rights. Under the Saudi Personal Data Protection Law you may ask to access, correct or delete your information, ask for a copy, or withdraw a consent at any time, and we will act on your request. Withdrawal does not affect anything done before it. Contact us through the WhatsApp number or email from which you received your invitation.
$doc$),
('MKT-VOICE-2026-11-v2', 'voice_processing', 'Voice Recording Consent', $doc$
I consent to my voice recording being processed by a third-party provider, as described in Section 8 of the Agreement.

Your recording is analysed by a third-party technology provider, which may be located outside Saudi Arabia. It is sent under a coded identifier, without your name or contact details. It is never shared with any potential match or other client, and it is kept for as long as you are a Maktoub client. You may withdraw this consent at any time and ask us to delete the recording.
$doc$),
('MKT-RESEARCH-2026-11-v1', 'voice_research', 'Anonymised Improvement Consent (optional)', $doc$
I consent to my voice recording and report being kept in anonymised form to improve Maktoub's services, as described in Section 8 of the Agreement.

This is optional. Saying no does not affect your membership in any way. You may change your mind at any time.
$doc$);

update public.maktoub_onboarding_settings set
  agreement_version = 'MKT-FOUNDING-2026-11-v2', privacy_version = 'MKT-PRIVACY-2026-11-v2',
  voice_version = 'MKT-VOICE-2026-11-v2', research_version = 'MKT-RESEARCH-2026-11-v1',
  agreement_approved_at = null, agreement_approved_by = null, updated_at = now()
where id;
commit;
