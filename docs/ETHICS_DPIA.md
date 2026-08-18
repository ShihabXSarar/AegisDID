# Ethics & Data Protection Impact Assessment (DPIA)

## 1. Prototype Data Disclaimer
**STATE PLAINLY:** Absolutely no real beneficiary data is collected, stored, or processed in this prototype. All demonstrations utilize synthetic embeddings or public domain testing imagery. The architecture specifically guarantees that if deployed to production, raw biometric data never leaves the beneficiary's local device.

## 2. Alignment with Humanitarian Data Principles

This architecture directly addresses the harms highlighted in our whitepaper regarding Rohingya biometric data sharing. 

### ICRC Handbook on Data Protection
* **Purpose Limitation:** The biometric embedding is mathematically bound to a specific policy allocation via a cryptographic Nullifier. It cannot be repurposed for surveillance or national ID tracking.
* **Data Minimization:** No biometric database exists. The system only retains a cryptographic hash (the `C_id`) on-chain. 
* **Do-No-Harm:** By eliminating central biometric honey-pots, we eliminate the risk of state-level actors or militias breaching the database to identify persecuted groups.

### UNHCR Data Protection Policy
The architecture conforms to UNHCR's mandate that refugees retain agency over their data. The cryptographic Zero-Knowledge Proof allows refugees to prove uniqueness without relinquishing the underlying biometric signature.

## 3. Volunteer Pilot Consent Scripts

To ensure informed consent in future field testing, we will use the following scripts prior to enrollment.

### English Consent Script
"Hello. We are testing a new system to distribute aid fairly. To make sure nobody claims aid twice, this app will look at your face and create a temporary math puzzle. Your actual photo will be deleted immediately and will never leave this phone. You will not be tracked. If you choose not to participate, it will not affect your current aid in any way, and we will not keep a record of your refusal. Do you agree to test this?"

### Bangla Consent Script (বাংলা সম্মতি পত্র)
"নমস্কার/আসসালামু আলাইকুম। আমরা সুষ্ঠুভাবে সাহায্য বিতরণের জন্য একটি নতুন সিস্টেম পরীক্ষা করছি। কেউ যেন দুবার সাহায্য নিতে না পারে তা নিশ্চিত করতে, এই অ্যাপটি আপনার চেহারার দিকে তাকিয়ে একটি গাণিতিক ধাঁধা তৈরি করবে। আপনার আসল ছবিটি সাথে সাথে মুছে ফেলা হবে এবং কখনোই এই ফোন থেকে বাইরে যাবে না। আপনাকে ট্র্যাক করা হবে না। আপনি যদি অংশগ্রহণ না করতে চান, তবে এটি আপনার বর্তমান সাহায্যে কোনো প্রভাব ফেলবে না, এবং আমরা আপনার অসম্মতির কোনো রেকর্ড রাখব না। আপনি কি এটি পরীক্ষা করতে সম্মত?"
