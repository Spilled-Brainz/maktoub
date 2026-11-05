-- Version 1 legal texts for the founding-member onboarding.
-- These are a working draft: real invites stay blocked until the founder approves
-- them in /onboard/admin/ (settings.agreement_approved_at). Any change after
-- approval must be a NEW version row, never an edit (rows are immutable).
-- Placeholders rendered at signing: {{PROVIDER}} legal entity name, {{FEE}} e.g. "SAR 2,500".
begin;
insert into public.maktoub_legal_documents (version, kind, title, body) values
('MKT-FOUNDING-2026-11-v1', 'agreement', 'Founding Member Agreement', $doc$
1. The parties
This agreement is between {{PROVIDER}} ("Maktoub", "we") and the person named in the signature below ("you"). It begins when you sign and continues until your programme ends under section 9.

2. What the programme is
Maktoub is a private, human-led matchmaking service for people seeking marriage. Your founding membership has three parts: (a) a private intake, consisting of your written answers and one short voice recording; (b) a personal report, prepared and reviewed by a person, followed by a report-review consultation with time for your questions; and (c) if you are approved as ready, a period of active matchmaking.

3. Fee
The founding rate is {{FEE}}, paid once, by bank transfer to the corporate account shown in your onboarding. Please transfer only to that account and include your reference code. Payment is verified manually; nothing is treated as paid until we confirm receipt. Any tax that applies will be shown on the invoice we send you.

4. Your report and consultation
Your report is due within seven (7) days of the later of (a) our verification of your payment and (b) your complete submission of the agreement, intake and voice recording. After the report is delivered we will arrange a report-review consultation and a question-and-answer session with you.

5. Readiness and active matchmaking
Active matchmaking begins only after we approve your readiness, which we assess at or after the consultation. If we believe you are not ready yet, we will tell you honestly and explain why, and we will not begin matchmaking. Once matchmaking begins, the programme aims for three (3) curated introductions over three (3) to six (6) months.

6. No guarantee
Matchmaking depends on other people and on circumstances outside anyone's control. We do not guarantee any number of introductions, any particular introduction, a marriage or any other outcome. The aim in section 5 describes how we work; it is not a promise.

7. Your approval comes first
No match will be introduced to you, and no information that identifies you will be disclosed to anyone, without your explicit approval for that specific introduction. You may decline any proposed introduction without giving a reason, and declining does not count against you.

8. Your commitments
You confirm that you are at least 18 years old, that you are free to marry, and that the information you give us is true and complete to the best of your knowledge. You agree to treat anyone introduced to you with respect and discretion, and not to share their personal information without their consent. We may pause or end your programme if any of these is not met.

9. Ending the programme
You may end your membership at any time by writing to us. If you end it before we have begun preparing your report, we will refund the fee in full. Once your report has been prepared, the fee is not refundable, because the work has been done. Your programme ends when the active matchmaking period ends, or earlier under this section.

10. Confidentiality and your data
We keep everything you share confidential, and we handle your personal data as described in the Privacy Notice you accept separately. Your voice recording is handled only as described in the separate Voice Recording Consent.

11. Responsibility
Maktoub provides introductions and guidance. It is not counselling, medical, psychological, legal or religious advice. Decisions about meeting, getting to know, or marrying anyone remain yours and your family's.

12. Law
This agreement is governed by the laws of the Kingdom of Saudi Arabia.

13. Electronic signature
By typing your full name and selecting "Sign", you sign this agreement electronically. Your electronic signature has the same effect as a handwritten one. We keep a record of the exact text you signed, the time and a fingerprint of the document, and you may ask us for a copy at any time.
$doc$),
('MKT-PRIVACY-2026-11-v1', 'privacy', 'Privacy Notice', $doc$
Who we are. {{PROVIDER}} ("Maktoub") is responsible for the personal data you give us during onboarding and the programme.

What we collect. Your contact details, date and time of birth, background and family details, your written intake answers (including how you describe your wellbeing and readiness), your voice recording, your agreement and consent records, and records of your payment.

Why we use it. Only to deliver your programme: preparing your report, holding your consultation, assessing readiness, finding suitable introductions, and keeping the records the law requires. We do not sell your data and we do not use it for advertising.

Who can see it. Only the Maktoub founder and team members who need it for your programme. Your records are stored privately with our hosting provider and are not public. Before any introduction, only the details you have explicitly approved for that introduction are shared, and only with that person.

How long we keep it. For the duration of your programme and up to twelve months after it ends, unless the law requires longer, after which it is deleted or anonymised. Agreement and payment records are kept as long as the law requires.

Your rights. Under the Saudi Personal Data Protection Law you may ask to see, correct, or delete your data, ask for a copy, or withdraw a consent. Withdrawal does not affect anything done before it, and some withdrawals may mean we can no longer provide parts of the programme. Contact us through the WhatsApp number or email from which you received your invitation.
$doc$),
('MKT-VOICE-2026-11-v1', 'voice_processing', 'Voice Recording Consent', $doc$
As part of your intake we ask you to record one short spoken answer. By giving this consent you agree that:

- Your recording is stored privately and is never published or shared with any potential match or other client.
- It is listened to only by the Maktoub founder and, where needed, a team member preparing your report, to understand how you express yourself and what matters to you.
- It may be transcribed to help prepare your report, but it is not used to train any artificial intelligence system and is not used to identify you by your voice.
- Every conclusion in your report is reviewed by a person.
- It is deleted once your report has been delivered and your consultation is complete, and in any case within ninety (90) days, unless you ask us to keep it longer.
- You may withdraw this consent at any time; we will then delete the recording. If you prefer not to record, tell us and we will agree another way to complete your intake.
$doc$);
commit;
