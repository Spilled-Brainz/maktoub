-- Readiness Programme legal drafts (v1). Immutable once inserted; changes = new version.
-- DRAFTS: require qualified legal review before a real client signs. Real invitations are refused
-- until the founder approves this set in /ready/admin/ (maktoub_programmes.documents_approved_at).
-- Placeholders rendered at signing: {{PROVIDER}}, {{FEE}}, {{VOICE_FEE}}, {{SESSIONS}}.

insert into public.maktoub_legal_documents (version, kind, title, body) values
('RP-AGREEMENT-2026-11-v1', 'programme_agreement', 'Readiness Programme Participation Agreement', $doc$
This Agreement is between {{PROVIDER}} ("Maktoub", "we") and the client named in the signature below ("you"). It applies to Maktoub | The Readiness Programme ("the Programme").

1. What the Programme is
The Programme is a personalised, 90-day mind-and-body readiness programme for a period of transition. It provides structure, guidance, education, coordination with independent professionals, and accountability.
It is non-clinical coaching and lifestyle education. It is not psychotherapy, counselling for a mental health condition, medical treatment, physiotherapy, dietetics, or emergency support. Participation assumes you are in sufficiently stable health for this kind of work.

2. The central principle
The Programme provides the support. Your commitment drives the progress.
Results depend substantially on your participation, consistency, individual circumstances and appropriate professional guidance. No particular result, outcome or change is guaranteed.

3. The three phases
- Month 1, Understand and Reset: assessment, baseline, first habits.
- Month 2, Build and Strengthen: progressive structure in movement, nutrition habits, sleep, and mindset work.
- Month 3, Integrate and Sustain: consolidation into routines you can keep without us.

4. What is included
- An initial readiness and lifestyle assessment.
- {{SESSIONS}} live sessions: initial assessment and planning (90 minutes); nutrition and movement habits (60 minutes); mindset barriers and recurring patterns (60 minutes); end of Month 1 review (60 minutes); end of Month 2 review (60 minutes); final 90-day review (90 minutes).
- Personalised weekly lifestyle and reflection protocols, approved by Maktoub before they start.
- Curated reading, research summaries, books, podcasts and videos.
- Your private client portal and, once enabled, Telegram check-ins.
- Weekly accountability tracking.
- Coordination with independent medical and movement professionals, where needed.
- A final 90-day progress review.

5. What is not included
Medical consultations, laboratory or other testing, gym or trainer fees, nutritionist or other professional fees, equipment, supplements, travel and any third-party service are not included in the {{FEE}} fee unless Maktoub agrees otherwise in writing. Independent professionals contract with and bill you directly.

6. Preparation and start date
After your payment is verified and we have the information we need, we take up to 10 calendar days to prepare your programme and tools. You receive an interim habit plan during this time. The preparation period is separate from the 90 days. The 90 days begin only on the official start date we agree together.

7. Your commitment
You agree to attend scheduled sessions, complete daily check-ins, engage with assigned educational material, work towards the non-clinical goals we agree, and tell us honestly about setbacks.
Accountability is expected. Setbacks are part of the work and will be met with adjustment, not shame. Repeated non-participation does not extend the Programme or create a refund entitlement.

8. Sessions
Sessions are held remotely or as agreed, at mutually convenient times. Please give at least 24 hours' notice to reschedule. A session missed without notice may be treated as delivered. Maktoub does not provide on-call or round-the-clock availability.

9. Digital tools and AI
The portal and check-in bot send reminders, record your answers and share material. They do not supervise you in real time, diagnose anything or give medical or psychiatric advice. Any automated summary is reviewed by a person before it informs your protocol. No individual exercise prescription, diet, medication, supplement or test is decided by AI.

10. Emergencies
The Programme is not an emergency service and messages are not monitored continuously. If you are in danger, unwell, or thinking of harming yourself, contact local emergency services immediately (911 in Saudi Arabia; 999 or 998 in the UAE) or go to the nearest hospital.

11. Confidentiality
Your information is confidential, used only to deliver the Programme, and handled as described in the consents you sign with this Agreement. Your identity and progress are never used in marketing without your written permission.

12. Fees, pauses and refunds
Fees, pauses, cancellation and refunds are governed by the Payment, Pause and Refund Terms, which form part of this Agreement.

13. General
This Agreement, with the documents signed alongside it, is the entire agreement for the Programme. It is governed by the laws of the Kingdom of Saudi Arabia. Nothing in it limits rights that cannot lawfully be excluded.
$doc$),

('RP-TERMS-2026-11-v1', 'programme_terms', 'Payment, Pause and Refund Terms', $doc$
1. Programme fee
The Programme fee is {{FEE}}, paid in full by bank transfer before preparation begins. Maktoub verifies every transfer by hand against its bank statement. A payment confirmation or screenshot is not treated as payment until the funds are verified.

2. Voice analysis (optional)
Voice analysis is an optional add-on at {{VOICE_FEE}}, paid separately. It may be requested at any time during the Programme. Analysis begins only after the add-on payment is verified and your recording is submitted.

3. Invoices
An invoice is issued in your portal once each payment is verified.

4. Pauses
If something serious comes up, such as illness, bereavement, unavoidable travel or a professional's advice, you may ask to pause. Pauses are granted at Maktoub's discretion depending on the circumstances. While paused, the programme clock stops and your end date moves by the length of the pause.
Maktoub may also pause the Programme if a required professional clearance is outstanding, or if continuing would not be appropriate for your wellbeing.

5. Activation
The Programme should start within 60 days of payment verification. If you do not respond to reasonable attempts to schedule the planning meeting or agree a start date within that time, the Programme may be treated as abandoned.

6. Refunds
Once paid, the fee is non-refundable, except where Maktoub materially fails to provide a service expressly included in the Programme. In that case, an appropriate refund for the undelivered part will be made. If the failure prevents delivery of the Programme as a whole, a full refund may be appropriate.
Refunds are not given because you change your mind, do not participate, do not complete the Programme, disagree with an assessment, or do not achieve a particular outcome. Preparation work, assessments, sessions held and materials issued count as delivered parts of the Programme.

7. Cancellation by Maktoub
If Maktoub ends the Programme for reasons other than your breach of the Agreement, you receive a pro-rata refund for the remaining days.

8. Third-party fees
Fees charged by independent medical, movement, nutrition or other professionals are separate, payable to them directly, and outside these terms.
$doc$),

('RP-MEDICAL-2026-11-v1', 'medical_disclaimer', 'Medical and Professional Services Disclaimer', $doc$
1. Maktoub is not a medical provider
Maktoub does not diagnose, treat or prevent any medical or psychological condition, does not prescribe medication, supplements, diets or individual exercise treatment, and does not interpret medical results.

2. Medical check-in before you start
Before starting structured physical activity, you agree to see a licensed physician of your choice for an initial check-in. We ask only for the outcome you choose to share: whether you are cleared to begin, and any practical limits we should respect (for example, "no high-impact running for now"). Please do not send us medical reports, test results or records through the portal, Telegram, email or any other channel.

3. Independent professionals
Doctors, trainers, nutritionists and other professionals we may suggest or coordinate with are independent. They are responsible for their own advice and services and contract with you directly. Maktoub uses only the non-diagnostic recommendations you authorise us to receive to shape your lifestyle plan.

4. Listen to your body
Stop any activity and seek medical attention if you experience pain, dizziness, chest discomfort, shortness of breath or any other concerning symptom. Tell us about any new injury, condition or change in medication that may affect your plan.

5. Mental wellbeing
The Programme supports reflection and behavioural consistency. It is not a substitute for care from a qualified mental health professional. If you need that care, we will encourage you to seek it and may pause the Programme while you do.
$doc$),

('RP-HEALTH-2026-11-v1', 'health_consent', 'Sensitive Health Information Consent', $doc$
1. Why we ask
To shape a safe, realistic lifestyle plan we need a small amount of information about your wellbeing. Health information is sensitive personal data, so we ask for your separate, explicit consent.

2. What we collect
- Self-reported wellbeing ratings (for example mental, physical and spiritual wellbeing, energy, sleep quality).
- Habits you describe: movement, sleep, nutrition patterns and routines.
- Injuries or limitations you choose to describe in your own words.
- Whether a professional has cleared you to begin, and any practical, non-diagnostic constraints you authorise us to receive.

3. What we do not collect
We do not collect or store medical reports, laboratory results, imaging, prescriptions or clinical records. Please do not send them to us through any channel. If one is sent by mistake, it will be deleted and not used.

4. How it is used
Only to design, adjust and review your Programme. It is not used for marketing, sold, used to train AI systems, or shared with anyone without your permission, except where the law requires.

5. Who can see it
Only the founder and, where strictly necessary, a named team member bound by confidentiality. Independent professionals receive only what you authorise.

6. Where it is stored
In access-restricted systems operated by our technology providers, who may store data outside the Kingdom of Saudi Arabia under appropriate safeguards. Only the minimum necessary information is held.

7. How long
For the Programme and 12 months after it ends, then deleted or irreversibly anonymised, unless the law requires longer.

8. Your rights
You may access or correct your information, ask for it to be deleted, or withdraw this consent at any time by telling us. Withdrawal may mean parts of the Programme can no longer be personalised safely.
$doc$),

('RP-DIGITAL-2026-11-v1', 'digital_consent', 'Digital Accountability and Telegram Consent', $doc$
1. Your private portal
Your portal is private to you, opened with your personal link. Keep the link to yourself, and tell us immediately if you think someone else has it so we can issue a new one.

2. Telegram check-ins
When your programme is ready, you may link Telegram through a one-time code. A Maktoub bot will then send morning, evening and weekly check-ins at times that suit your schedule and time zone, plus reminders and educational material. Your structured answers sync to your portal.

3. What Telegram is not for
Please do not share detailed health information, medical results or anything you would not want stored by a messaging provider through Telegram. Use your portal for anything sensitive. Telegram is a third-party service with its own privacy terms.

4. No real-time supervision
Check-ins are automated. They are reviewed as part of your programme, not monitored continuously. The bot does not diagnose, give psychiatric or medical advice, or replace emergency services.

5. Your control
You choose quiet hours, can pause notifications at any time, and can unlink Telegram whenever you wish. Missed check-ins trigger a gentle reminder, never public or shaming messages.

6. Contact
Maktoub may contact you by WhatsApp, Telegram, email or phone about your Programme. You can opt out of non-essential messages at any time.
$doc$),

('RP-VOICE-2026-11-v1', 'programme_voice', 'Voice Analysis Consent (optional add-on)', $doc$
1. What happens
If you choose voice analysis, you record at least two minutes of speech in your portal. The acoustic properties of your voice are analysed by a specialist third-party provider. Your words are read by the founder. Together they inform a private report.

2. What the report is
Voice analysis is an additional signal layer that suggests patterns to explore and test during the Programme. It is not a diagnosis, a psychological assessment or a standalone verdict.

3. Privacy
Where reasonably possible the recording is sent to the provider without your name or contact details. It is not used to train AI or machine-learning systems without your separate explicit consent. The recording is stored privately and deleted within 30 days of your report being delivered, unless you ask us to delete it sooner.

4. Timing
Analysis starts once the add-on payment is verified and your recording is submitted. Reports usually take about seven days.

5. Withdrawal
You may withdraw this consent before analysis begins and your recording will be deleted.
$doc$);
